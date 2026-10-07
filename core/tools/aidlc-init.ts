#!/usr/bin/env bun
import { LONG_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
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
  CONFIG_SECTIONS,
  EXIT,
  type CommandResult,
  emitResult,
  failure,
  globalOptions,
  readTerminalLine,
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
  AIDLC_HOOK_ENTRY_PREFIX,
  aidlcHookRegistrationHashes,
  aidlcHookRegistrations,
  aidlcHookTarget,
  assertProjectionPathHasNoSymlinks,
  hostToolPath,
  emptyJsonObject,
  insertJsoncSetting,
  type JsonEntriesOwnership,
  jsonFileText,
  isCustomClaudeStatusLine,
  jsoncRootMembers,
  jsoncSettingValue,
  legacyAidlcHookTarget,
  mergeBlock,
  mergeJsonEntries,
  type ProjectionDescriptor,
  projectionFiles,
  readJsonFile,
  readRootIntegrations,
  removeJsonEntries,
  removeJsoncSetting,
  replaceJsoncSetting,
  copyStartsWithout,
  rootBlockPath,
  sha256Bytes,
  sha256File,
  sha256FileMatching,
  sha256Matching,
  shippedRootIntegrationPath,
  unionBlocks,
  validateProjectionDescriptor,
  walkFiles,
  withoutBom,
} from "./aidlc-distribution.ts";
import {
  activeVersion,
  binRoot,
  machineTransactionRoot,
  projectDirFrom,
  runtimeRoot,
} from "./aidlc-install-paths.ts";
import { defaultHarnessPath } from "./aidlc-machine-config.ts";
import {
  configureChannel,
  configureProjectPin,
  installPinnedRelease,
  LifecycleCommandError,
  pinnedReleaseInstalled,
  holdPinnedRelease,
  registerProjectPin,
  resolvePinnedDispatch,
} from "./aidlc-lifecycle.ts";
import {
  acquireCopyRuntime,
  copyRuntimeUrl,
  releaseCopyRuntimeAsset,
  releaseHostLabel,
  ReleaseUnavailableError,
  ReleaseVerificationError,
} from "./aidlc-release.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import { compareVersions, RELEASE_CHANNELS, VERSION_ID } from "./aidlc-channel.ts";
import {
  type TransactionOperation,
  type TransactionOptions,
  type TransactionPlan,
  TransactionFilesystemError,
  assertTransactionFilesystem,
  executePlan,
  transactionSourceHash,
  transactionState,
  validateTransactionPlan,
  writeOperation,
} from "./aidlc-transaction.ts";
import {
  compileStageGraph,
  materializeComposedScopeIdentities,
  __resetGraphCache,
  memoryDirFor,
} from "./aidlc-graph.ts";
import {
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
  activeSpace,
  activeWorkflowDescriptions,
  DEFAULT_SPACE,
  fileIdentity,
  normalizeProjectFlagsRecord,
  RECORDABLE_PROJECT_BYPASSES,
  type ProjectFlagsRecord,
  normalizeDriveLetter,
  sameFileIdentity,
  withAuditLock,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import { regenerateRunnerSurfaces } from "./aidlc-runner-gen.ts";
import { KIRO_IDE_STEERING, kiroIdeSteering } from "./aidlc-includes.ts";
import {
  activeWorkflowPluginDependencies,
  canonicalScopeTableRegion,
  canonicalStageTableRegion,
  renderScopeTable,
  renderStageTable,
} from "./aidlc-utility.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
  isCompiledExecutable,
  projectedDispatcher,
  type ProjectHarness,
  hasControlCharacters,
  quoteCommandArgument,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import {
  applyKiroSessionPlan,
  hasLegacyKiroEffortMap,
  isKiroPreset,
  KIRO_AUTO_DEFINITION,
  KIRO_EFFORT_LABEL,
  KIRO_PRESET_EFFORT,
  kiroAutoRecommendation,
  kiroCliPath,
  type KiroModel,
  type KiroModelList,
  type KiroPersonalSession,
  type KiroPreset,
  kiroRateLabel,
  type KiroSessionPlan,
  type KiroSessionResult,
  listKiroModels,
  readKiroPersonalSession,
  recommendedKiroModel,
  setByDotenvFile,
} from "./aidlc-kiro-session.ts";
import {
  activeModelGroups,
  applyModelPolicyToProjection,
  HARNESS_HONESTY,
  HARNESS_PRODUCT_NAMES,
  harnessHonestyNotes,
  isModelEffort,
  isModelPreset,
  MODEL_EFFORTS,
  MODEL_GROUPS,
  MODEL_PRESETS,
  modelPolicyAgentsDir,
  modelPolicyIsEmpty,
  modelPolicySurfaceDrift,
  normalizeModelPolicy,
  profileGroups,
  readAgentTiers,
  resolveModelPolicy,
  sessionModelsDetail,
  sessionSetsAgentModels,
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
  harnessOwnsModelAccess,
  providerAnswerIsTheSession,
  sessionModelAccessFact,
  availableScopeNames,
  CODEX_HOOK_TRUST_UNMET,
  codexHookTrustStep,
  completionInstruction,
  copilotCliTrust,
  detectAwsCredentials,
  discoverInstalledPluginNames,
  effectiveProjectFlagValues,
  flagFiles,
  flagIssues,
  hasLegacyClaudeProviderConfig,
  hasLegacyCodexProviderConfig,
  insideGitRepository,
  managedBlockMarkers,
  normalizeProvidersRecord,
  withRecordedMcpRegion,
  normalizeProjectChoicesRecord,
  normalizeRuntimeRecord,
  normalizeTrustRecord,
  ownedModelAccessFact,
  pendingProviderIssues,
  postApplyOutstandingActions,
  shellOnlyRuntimes,
  preserveKiroMcpRegion,
  probeHarnessCli,
  probeRuntime,
  providerFiles,
  providerIssues,
  providerMenuCopy,
  providerSurfaceIssues,
  projectChoiceFiles,
  projectChoiceIssues,
  projectMcpNote,
  readPluginSelection,
  readConfigDiagnosticRecords,
  reconcileProviderActions,
  runtimeIssues,
  stripLegacyClaudeModelAliases,
  trustStatus,
  workspaceShellRefreshCommand,
  type ConfigDiagnosticOverrides,
  type ConfigDiagnosticRecords,
  type CompletionShell,
  type ConfigOutstandingAction,
  type DiagnosticIssue,
  type ProjectChoicesRecord,
  type ProvidersRecord,
  type RuntimeRecord,
  type TrustRecord,
} from "./aidlc-config-diagnostics.ts";
import { committedRecordIgnoreConflicts } from "./aidlc-gitignore.ts";
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
import { recordSwitchChange, switchesOffLines } from "./aidlc-recorded-switches.ts";

type RootContribution =
  | { policy: "managed-block"; hash: string; marker?: string }
  | { policy: "json-map"; entries: Record<string, string>; key?: string }
  | { policy: "json-array"; entries: Record<string, string>; key: string }
  | { policy: "whole-file"; hash: string }
  // Only the settings AI-DLC itself added, with the value it wrote; created
  // records that the file did not exist before.
  | { policy: "jsonc-settings"; entries: Record<string, string>; added?: string[]; created?: boolean }
  // Each entry AI-DLC owns in a team's JSON file (opencode.json), with the
  // value hash it wrote; created records that AI-DLC created the file.
  | { policy: "json-entries"; entries: Record<string, string>; created?: boolean };

type Baseline = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
  mcpMode: "defaults" | "none";
  files: Record<string, string>;
  // Set once `files` holds only shipped paths. An older manifest may also
  // record the project's own files under the harness dir (#1516).
  shippedOnly?: true;
  entries?: Record<string, Record<string, string>>;
  rootContributions: Record<string, RootContribution>;
};

type PreparedRefreshSource = {
  root: string;
  cleanup?: string;
  regenerated: Set<string>;
  retiredManagedFiles: Set<string>;
  projectOverlays?: ReadonlySet<string>;
  // Files whose merge could not be proven: a refresh replaces them only with --force.
  unproven?: ReadonlySet<string>;
  entries?: Baseline["entries"];
  notes: string[];
};

type PlannedAction = {
  path: string;
  action: "create" | "update" | "merge" | "preserve" | "remove" | "conflict";
  detail?: string;
};

// A section's "Apply ...? [y/N]" question. main() asks it once it knows whether
// the change also needs a release download, so one answer covers both.
type PendingConfirm = { question: string; cancelled: string };

type ModelsMutationContext = {
  confirm?: PendingConfirm;
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
type SetupWalkSection = "models" | "runtime" | "providers" | "trust";

type ConfigMainInternal = {
  setupWalkChild?: boolean;
  sourceRoot?: string;
};

type DiagnosticsMutationContext = {
  confirm?: PendingConfirm;
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
  confirm?: PendingConfirm;
  section: ChoiceSection;
  distribution: string;
  /** Several harnesses are installed and none was named: only a bypass gets here. */
  anyHarness?: true;
  harness: ModelHarness;
  harnessDir: string;
  previous: ProjectFlagsRecord | ProjectChoicesRecord | null;
  next: ProjectFlagsRecord | ProjectChoicesRecord | null;
  previousPlugins: string[] | null;
  nextPlugins: string[] | null;
  overrides?: ConfigDiagnosticOverrides;
  mcpMode?: "defaults" | "none";
  /** MCP is on because the project already has the shipped servers. */
  keepPresentServers?: true;
  summaryLines: string[];
  notes: string[];
  settings?: SettingsMutation;
  /** A no-layer clear's other layers that also record the bypass. */
  extraSettings?: SettingsMutation[];
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
  "--channel",
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
  "--question-retention-days",
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
  "--from",
  "--harness",
  "--hook-debug",
  "--mcp",
  "--plan-token",
  "--plugins",
  "--project-dir",
  "--sensor-timeout-ms",
  "--question-retention-days",
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
  "--session-model",
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

const VALID_CONFIG_SECTIONS = new Set<string>(CONFIG_SECTIONS);

const ROOT_CONFIG_FLAGS = new Set([
  "--ca-bundle",
  "--channel",
  "--download",
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

// `--download` lets a config command fetch the release its project needs. The
// two release settings choose where that release comes from, so outside
// `config --pin` they mean something only alongside it.
const DOWNLOAD_VALUE_FLAGS = ["--release-base-url", "--ca-bundle"] as const;

function withDownloadGrammar(
  argv: readonly string[],
  grammar: ConfigOptionGrammar,
): ConfigOptionGrammar {
  return {
    ...grammar,
    values: argv.includes("--download")
      ? new Set([...grammar.values, ...DOWNLOAD_VALUE_FLAGS])
      : grammar.values,
    bare: new Set([...grammar.bare, "--download"]),
  };
}

function validateDownloadArgs(argv: readonly string[], sourceFlag: boolean): string | null {
  if (!argv.includes("--download")) {
    const setting = DOWNLOAD_VALUE_FLAGS.find((flag) => argv.includes(flag));
    return setting ? `${setting} requires --download` : null;
  }
  return sourceFlag && argv.includes("--from")
    ? "--download and --from are mutually exclusive"
    : null;
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

const SETTINGS_LAYERS = ["local", "project", "global"] as const;

/** The layers, nearest first, whose own file records `name` as a bypass. */
function layersRecordingBypass(projectDir: string, name: string): SettingsTarget[] {
  return SETTINGS_LAYERS.filter((layer) =>
    (readSettingsTarget(projectDir, layer)?.flags?.bypasses ?? []).some((recorded) => recorded === name)
  );
}

/** The change `argv` makes to one settings layer's own file. */
function flagsMutationFor(
  argv: readonly string[],
  projectDir: string,
  harnessRoot: string,
  target: SettingsTarget,
): SettingsMutation {
  const previous = readSettingsTarget(projectDir, target);
  return {
    target,
    path: settingsPathForTarget(projectDir, target),
    previous,
    next: updateSettingsSection(previous, "flags", buildFlagsRecord(previous?.flags ?? null, argv, harnessRoot)),
  };
}

// A bypass typed with no layer is the person's own switch. --bypass records it
// in their local file; --clear-bypass clears it from every layer that records
// it, so turning a check back on does just that. Any other change with no
// layer, or one that both adds and clears, is asked about as before (null).
function bypassSettingsTargets(
  argv: readonly string[],
  projectDir: string,
  harnessRoot: string,
): SettingsTarget[] | null {
  if (SETTINGS_TARGET_FLAGS.some(([flag]) => argv.includes(flag))) return null;
  if (argv.includes("--reset") || !settingsProjectAvailable(projectDir)) return null;
  const adds = valuesAfter(argv, "--bypass");
  const clears = valuesAfter(argv, "--clear-bypass");
  if ((adds.length > 0) === (clears.length > 0)) return null;
  const holding = SETTINGS_LAYERS.filter((layer) =>
    clears.some((name) => layersRecordingBypass(projectDir, name).includes(layer))
  );
  const targets: SettingsTarget[] = adds.length > 0 || holding.length === 0 ? ["local"] : holding;
  return targets.every((target) =>
      bypassOnlyRequest(argv, flagsMutationFor(argv, projectDir, harnessRoot, target))
    )
    ? targets
    : null;
}

function validateModelsArgs(argv: readonly string[]): string | null {
  // `config models --from` names a preset or profile, not source bytes.
  const download = validateDownloadArgs(argv, false);
  if (download) return download;
  const grammar = validateConfigOptionGrammar(argv, "models", withDownloadGrammar(argv, {
    values: MODELS_VALUE_FLAGS,
    bare: MODELS_BARE_FLAGS,
  }));
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
    "--session-model",
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
  if (argv.includes("--agent") && !argv.includes("--effort") && !argv.includes("--model")) {
    return "--agent requires --effort <value> or --model <raw-id>";
  }
  if (
    !argv.includes("--agent") &&
    (argv.includes("--effort") || argv.includes("--model"))
  ) {
    return "--effort and --model require --agent <name>";
  }
  return null;
}

// `config --channel [stable|preview]` reads or sets the machine release
// channel. The value is optional: bare `--channel` prints the channel in force.
function validateChannelConfigArgs(argv: readonly string[]): string | null {
  const index = argv.indexOf("--channel");
  const value = argv[index + 1];
  const hasValue = value !== undefined && !value.startsWith("--");
  if (hasValue && !(RELEASE_CHANNELS as readonly string[]).includes(value)) {
    return `--channel must be ${RELEASE_CHANNELS.join(" or ")}`;
  }
  const rest = [
    ...argv.slice(0, index),
    ...argv.slice(index + (hasValue ? 2 : 1)),
  ];
  if (rest.includes("--channel")) return "--channel may be specified only once";
  const grammar = validateConfigOptionGrammar(rest, "config --channel", {
    values: new Set(["--project-dir"]),
    bare: new Set(["--help", "--json", "--no-color", "--quiet", "--verbose"]),
    invalidKnownFlags: ROOT_CONFIG_FLAGS,
    invalidKnownMessage: (flag) => `${flag} is not valid with config --channel`,
  });
  if (grammar) return grammar;
  return validateConfigOutputMode(argv);
}

// `config --show [--json]` reads every section and changes nothing, so it takes
// only the flags that shape its output and --project-dir.
const ROOT_SHOW_BARE_FLAGS = new Set(["--show", "--json", "--no-color", "--help"]);

function validateRootShowArgs(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--project-dir") {
      i++;
      continue;
    }
    if (!ROOT_SHOW_BARE_FLAGS.has(token)) return `${token} cannot be combined with config --show`;
  }
  return argv.filter((token) => token === "--show").length > 1 ? "--show may be specified only once" : null;
}

function validateRootConfigArgs(argv: readonly string[]): string | null {
  if (argv.includes("--show")) return validateRootShowArgs(argv);
  const hasPin = argv.includes("--pin");
  const hasUnpin = argv.includes("--unpin");
  if (hasPin && hasUnpin) return "--pin and --unpin are mutually exclusive";
  if (argv.includes("--channel")) {
    if (hasPin || hasUnpin) return "--channel cannot be combined with --pin or --unpin";
    return validateChannelConfigArgs(argv);
  }

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
  if (!hasPin && !hasUnpin) {
    const download = validateDownloadArgs(argv, true);
    if (download) return download;
  }
  const grammarSets = { values, bare };
  const grammar = validateConfigOptionGrammar(argv, mode, {
    ...(hasPin || hasUnpin ? grammarSets : withDownloadGrammar(argv, grammarSets)),
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
  const invoke = configInvocationFor();
  const out = process.stdout;
  return [
    "Choose model and effort policy for each agent",
    "",
    heading("USAGE", out),
    `  ${cmd(`${invoke} config models [flags]`, out)}`,
    "",
    "Pins bind in both directions: a pinned agent stays pinned if the session later moves to a larger model.",
    "Without a recorded policy, Deciding and Writing up inherit; only the shipped reviewing tier pins medium effort.",
    "",
    heading("POLICY", out),
    "  --preset <thorough|balanced|minimal>",
    "    thorough: session effort for deciding and writing up, extra-high reviewing",
    "    balanced: medium effort for deciding, reviewing, and writing up (wizard default)",
    "    minimal: medium deciding and reviewing, low writing up",
    "  --from <preset|profile> [--save-as <name>]",
    "  --deciding-effort <low|medium|high|xhigh|max>",
    "  --reviewing-effort <low|medium|high|xhigh|max>",
    "  --writing-up-effort <low|medium|high|xhigh|max>",
    "  --agent <name> [--effort <value>] [--model <raw-id>]  (one or both)",
    "  --reset",
    "",
    heading("KIRO CLI", out),
    "  Kiro CLI runs each session on one model, so a preset sets one effort for the whole",
    "  session (minimal low, balanced medium, thorough extra-high), saved with the model in",
    "  your personal Kiro settings. A model without that level gets its next level down.",
    "  --session-model <id>  save this model from your Kiro account's list as your session model",
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
    "  --download   fetch and verify the release this project needs (its pin, else its current version) when it is not on this machine; --release-base-url and --ca-bundle choose the source",
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

// A printed config command about one harness of the project names that
// harness when the project has more than one, since config would otherwise
// ask which.
function namedHarness(projectDir: string, harness: string | undefined): string {
  return harness && discoverProjectHarnesses(projectDir).length > 1 ? ` --harness ${harness}` : "";
}

// A `config models` command about one harness of the project, run as shown
// from where the user is.
function modelsCommand(projectDir: string, harness: ModelHarness, args: string): string {
  return `${configInvocationFor(projectDir)} config models ${args}${namedHarness(projectDir, harness)}${projectTarget(projectDir)}`;
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
  if (options.mode !== "human") {
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
      : sessionSetsAgentModels(harness)
      ? `nothing; ${sessionModelsDetail(harness, null)}`
      : `nothing yet - run '${modelsCommand(projectDir, harness, "--preset balanced --project --yes")}'`
  }\n`;
  writeMenuText(output);
  for (
    const line of commandRowLines(
      "Full per-agent list: ",
      modelsCommand(projectDir, harness, "--show --json"),
      menuWidth(),
    )
  ) {
    process.stdout.write(`${dim(line, out)}\n`);
  }
  process.exitCode = EXIT.ok;
}

function modelsPipelineArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  const keptValues = new Set(["--harness", "--plan-token", "--project-dir", ...DOWNLOAD_VALUE_FLAGS]);
  const keptBare = new Set([
    "--download",
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
  if (agent && !effort && !model) throw new Error("--agent requires --effort <value> or --model <raw-id>");
  if (!agent && (effort || model)) throw new Error("--effort and --model require --agent <name>");
  if (effort && !isModelEffort(effort)) {
    throw new Error(`--effort must be one of ${MODEL_EFFORTS.join(", ")}`);
  }
  // A model alone leaves the agent's effort where it was, and an effort alone
  // its model.
  if (agent && (effort || model)) {
    next.agents ??= {};
    next.agents[agent] = {
      ...(next.agents[agent] ?? {}),
      ...(effort ? { effort: effort as ModelEffort } : {}),
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
  writeMenuText(
    "Pins bind in both directions, and shipped tiers never raise an agent above the session.\n",
  );
  const choice = configPrompt(
    "Models [Enter keep everything, 1 preset, 2 group efforts, 3 set each one myself]:",
  )?.trim();
  if (!choice) return current;
  if (choice === "1") {
    writeMenuText(
      "Presets:\n" +
        "  thorough: session effort for deciding and writing up, extra-high reviewing\n" +
        "  balanced: medium effort for deciding, reviewing, and writing up\n" +
        "  minimal: medium deciding and reviewing, low writing up\n",
    );
    const selected = configPrompt("Preset [thorough/balanced/minimal]:")?.trim() ?? "";
    if (!isModelPreset(selected)) throw new Error("preset selection cancelled");
    return applyModelsFlags(targetCurrent, ["--preset", selected], tiers, current);
  }
  if (choice === "2") {
    const args: string[] = [];
    for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
      const currentValue = groupPolicyEffort(current, group) ?? "shipped";
      writeMenuText(
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
      writeMenuText(
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
  const download = validateDownloadArgs(argv, false);
  if (download) return download;
  const grammar = validateConfigOptionGrammar(argv, section, {
    ...withDownloadGrammar(argv, { values: sectionValues, bare: sectionBare }),
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
  const invoke = configInvocationFor();
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
    "  --download   fetch and verify the release this project needs (its pin, else its current version) when it is not on this machine; --release-base-url and --ca-bundle choose the source",
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
        "  --provider <current|amazon-bedrock|other>",
        "  --region <aws-region>",
        "  --profile <aws-profile>",
        "  --opencode-default <yes|no>",
        "  --acknowledge",
        "  --mark-done <pending-action-id>",
        "",
        "--region, --profile, and --opencode-default apply only when the recorded or selected provider is amazon-bedrock.",
        "Credential detection is offline only. No provider or model endpoint is contacted.",
      ]
    : [
        heading("Trust answers:", out),
        "  --acknowledge",
        "",
        "Trust is read, verified, and instructed. This section never regenerates trust seeds or permission rules.",
        "On Copilot, the step says whether the Copilot CLI has trusted this folder and how to trust it with the CLI's own prompt; it never edits the CLI's config.",
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

// The projected descriptor's product name ("Kiro CLI", "Claude Code"), so a
// prompt can name the harness the user is actually running; the distribution
// id is the fallback when the descriptor is unreadable. The descriptor is a
// project file, so only a plain name reaches the terminal.
const PLAIN_PRODUCT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,39}$/;

function projectionProductName(root: string, distribution: string): string {
  try {
    const value = JSON.parse(
      readFileSync(join(root, "tools", "data", "harness.json"), "utf-8"),
    ) as { productName?: unknown };
    if (
      typeof value.productName === "string" &&
      PLAIN_PRODUCT_NAME.test(value.productName)
    ) {
      return value.productName;
    }
  } catch {
    // An unreadable descriptor is reported by the doctor checks, not here.
  }
  return distribution;
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
  const keptValues = new Set(["--harness", "--plan-token", "--project-dir", ...DOWNLOAD_VALUE_FLAGS]);
  const keptBare = new Set([
    "--download",
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
      harnessManaged: harnessOwnsModelAccess(selected.harness),
      record,
      credentials,
      pendingActions: pendingProviderIssues(record, selected.harness),
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
  if (options.mode !== "human") {
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
    if (data.harnessManaged) {
      const product = projectionProductName(selected.root, selected.distribution);
      output += `  Model access: comes with ${product}; AI-DLC configures no model provider\n`;
      if (record !== null) {
        output += `  Legacy provider answer present and ignored; ${configCommand("providers --reset")} clears it.\n`;
      }
    } else {
      const credentials = data.credentials as ReturnType<typeof detectAwsCredentials>;
      output += `  Provider: ${record?.provider ?? "harness provider in use (not recorded)"}\n`;
      if (record?.provider === "amazon-bedrock") {
        output += `  Region: ${record.region}\n`;
        output += `  Profile: ${record.profile ?? "default credential chain"}\n`;
      } else {
        output += "  Region: not managed by AI-DLC\n";
        output += "  Profile: not managed by AI-DLC\n";
      }
      output += `  Offline credentials: ${credentials.hasCredentials ? "found" : "not found"}\n`;
      for (const source of credentials.sources) output += `    source: ${source}\n`;
    }
    const pending = new Set(
      (data.pendingActions as ReturnType<typeof pendingProviderIssues>)
        .map((issue) => issue.id),
    );
    for (const issue of data.issues as DiagnosticIssue[]) {
      const label = pending.has(issue.id)
        ? "Pending"
        : issue.severity === "warn"
        ? "Warning"
        : "Unmet";
      output += `  ${label}: ${issue.id} - ${issue.message}\n`;
      output += `    fix: ${issue.remediation}\n`;
    }
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
  let issues: DiagnosticIssue[];
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
  const blockers = issues.filter((issue) => issue.severity !== "warn");
  const warnings = issues.filter((issue) => issue.severity === "warn");
  // Only the person can give Codex its hook trust, inside Codex.
  const hostSteps = [...new Set(blockers.map((issue) => codexHookTrustStep(issue.id)))];
  const hostStep = hostSteps.length === 1 ? hostSteps[0] : null;
  const providersUnrecorded = section === "providers" && records.providers === null;
  const cleanMessage = section === "providers" && harnessOwnsModelAccess(selected.harness)
    ? `providers needs no answer for ${selected.harness}; its model access is harness-managed`
    : providersUnrecorded && providerAnswerIsTheSession(selected.harness)
    ? `providers needs no answer for ${selected.harness}; ` +
      sessionProvidersDetail(
        selected.harness,
        `'${configInvocationFor(projectDir)} config providers --harness ${selected.harness}${projectTarget(projectDir)}'`,
      )
    : providersUnrecorded
    ? `providers has no recorded answer for ${selected.harness}; the shipped fallback is in use. ` +
      `Record one with '${configCommand("providers")}'`
    : warnings.length > 0
    ? `${section} configuration has ${warnings.length} warning(s) for ${selected.harness}: ${
      warnings.map((issue) => `${issue.id} (${issue.message})`).join("; ")
    }`
    : `${section} configuration is clean for ${selected.harness}`;
  emitResult(
    blockers.length === 0
      ? success(cleanMessage, {
          section,
          harness: selected.harness,
          issues: warnings,
        })
      : failure(
          `${section} configuration has ${blockers.length} unmet item(s): ${
            blockers.map((issue) => `${issue.id} (${issue.message})`).join("; ")
          }`,
          EXIT.failure,
          hostStep ?? configCommand(`${section} --show`),
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
  if (harnessOwnsModelAccess(selected.harness)) throw new Error(`${selected.harness} provides its own model access; there is no provider answer to record. Use --reset to clear a legacy record.`);
  const next = cloneDiagnosticRecord(current) ?? { schemaVersion: 1 };
  const provider = valueAfter(argv, "--provider");
  if (provider === "builtin" || (provider === undefined && next.provider === "builtin")) {
    throw new Error("--provider builtin is legacy-only; choose current, amazon-bedrock, or other");
  }
  if (
    provider !== undefined &&
    provider !== "current" &&
    provider !== "amazon-bedrock" &&
    provider !== "other"
  ) {
    throw new Error("--provider must be current, amazon-bedrock, or other");
  }
  if (provider) {
    next.provider = provider;
    if (provider !== "amazon-bedrock") {
      delete next.region;
      delete next.profile;
      delete next.opencodeDefault;
    }
  }
  if (
    next.provider !== "amazon-bedrock" &&
    ["--region", "--profile", "--opencode-default"].some((flag) => argv.includes(flag))
  ) {
    throw new Error("--region, --profile, and --opencode-default require --provider amazon-bedrock");
  }
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
  if (
    next.provider !== current?.provider ||
    next.region !== current?.region ||
    next.profile !== current?.profile ||
    next.opencodeDefault !== current?.opencodeDefault
  ) {
    delete next.acknowledged;
    delete next.pendingActions;
  }
  if (argv.includes("--acknowledge")) next.acknowledged = true;
  if (!next.provider) {
    throw new Error(
      "provider configuration requires --provider <current|amazon-bedrock|other>",
    );
  }
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
  let reconciled = reconcileProviderActions(
    normalizeProvidersRecord(next) as ProvidersRecord,
    selected.harness,
    argv.includes("--acknowledge"),
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

function currentProviderNarration(harness: ModelHarness): string {
  if (harness === "claude" || harness === "codex" || harness === "opencode") {
    return "  Keeping the current harness provider; attributable AI-DLC Bedrock overrides will be removed when present, and other provider settings will be kept.";
  }
  return "  Keeping the current harness provider; no project provider settings will be written.";
}

function currentProviderSummary(harness: ModelHarness): string {
  if (harness === "claude" || harness === "codex" || harness === "opencode") {
    return "  Providers    current harness provider; attributable AI-DLC overrides cleared when present";
  }
  return "  Providers    current harness provider; no project provider settings written";
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
        writeMenuRow("    ", issue.remediation);
      }
      process.stdout.write("\n");
      writeCommandRow(
        "  Full diagnostics: ",
        configCommandForHarness(selected.harnessDir, "runtime --show"),
      );
      process.stdout.write("\n");
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
    if (harnessOwnsModelAccess(selected.harness)) return records.providers;
    const credentials = detectAwsCredentials();
    const detected = awsSummary(credentials);
    process.stdout.write("\n  Model provider\n");
    const copy = providerMenuCopy(selected.harness);
    writeMenuRow(
      "  ",
      credentials.hasCredentials
        ? `Found AWS credentials (${detected.source}); ${
          detected.regionSource === "detected" ? "detected" : "fallback"
        } region ${detected.region}.`
        : "No AWS credentials were detected.",
    );
    const recordedBedrock = records.providers?.provider === "amazon-bedrock"
      ? records.providers
      : null;
    const recordedOther = records.providers?.provider === "other"
      ? records.providers
      : null;
    writeMenuRow(
      "    1. keep current     ",
      `inherit the provider already configured in the harness${
        recordedBedrock
          ? ""
          : recordedOther
          ? " (recorded: other; default)"
          : " (default)"
      }`,
    );
    writeMenuRow("    2. amazon-bedrock   ", `${copy.bedrock}${
      recordedBedrock
        ? ` (recorded: ${recordedBedrock.region}, ${
          recordedBedrock.profile || "default credential chain"
        }; default)`
        : credentials.hasCredentials
        ? " (AWS credentials detected)"
        : ""
    }`);
    const choice = promptChoice("  Provider", 2, recordedBedrock ? 2 : 1);
    const providerAnswer = choice === 1
      ? recordedOther
        ? "other"
        : "current"
      : "amazon-bedrock";
    const args = ["--provider", providerAnswer];
    const skipMarkDone = new Set<string>();
    if (choice === 2) {
      const region = promptTextDefault(
        "  AWS region",
        recordedBedrock?.region ?? detected.region,
      );
      const profileAnswer = promptTextDefault(
        "  AWS profile",
        recordedBedrock?.profile ?? "default credential chain",
      );
      const profile = profileAnswer === "default credential chain"
        ? ""
        : profileAnswer;
      args.push("--region", region);
      if (profile) args.push("--profile", profile);
      writeMenuText(
        `  Using amazon-bedrock in ${region} with ${
          profile || "the default credential chain"
        }.\n\n`,
      );
      if (selected.harness === "opencode") {
        const offer = promptYesDefault(
          "  Write amazon-bedrock provider options to opencode.json?",
          recordedBedrock?.opencodeDefault ?? false,
        );
        args.push("--opencode-default", offer ? "yes" : "no");
      }
      if (
        selected.harness === "codex" ||
        selected.harness === "copilot" ||
        selected.harness === "cursor"
      ) {
        writeMenuText(
          selected.harness === "codex"
            ? "Configure the provider, credentials, and model in ~/.codex/config.toml before acknowledging this step.\n"
            : selected.harness === "copilot"
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
          const action = selected.harness === "codex"
            ? "codex-provider-configuration"
            : selected.harness === "copilot"
            ? "copilot-byok-configuration"
            : "cursor-provider-configuration";
          skipMarkDone.add(action);
          writeMenuText(
            `  ${action} remains pending. Complete it with --acknowledge or --mark-done ${action}.\n`,
          );
        }
      }
    } else {
      writeMenuText(`${currentProviderNarration(selected.harness)}\n\n`);
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
  // Codex's own hook trust comes first, so the review question below never
  // reads as that step.
  const codexStep = selected.harness === "codex"
    ? trustStatus(projectDir, selected.harnessDir, selected.harness).issues
      .map((issue) => codexHookTrustStep(issue.id)).find((step) => step !== null)
    : undefined;
  if (codexStep) writeMenuRow("  ", `${CODEX_HOOK_TRUST_UNMET}: ${codexStep}.`);
  const answer = promptYesDefault(
    codexStep
      ? "  Separately, record that you reviewed AI-DLC's trust and allowlist files?"
      : "  Record that you reviewed the trust and allowlist files?",
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

// The Copilot trust step. Hooks in VS Code need a trusted folder and Chat: Use
// Hooks on, which AI-DLC cannot read, so the step names them. The Copilot CLI
// keeps its own trusted folders and asks the person itself; trusting a folder
// lets its code run, so the step points at that prompt and never edits the
// CLI's config on the person's behalf.
function copilotTrustStep(projectDir: string): CommandResult {
  writeMenuText(
    "\n  In VS Code, hooks also need a trusted folder and Chat: Use Hooks on (your organization can switch it off); AI-DLC cannot see either.\n",
  );
  const trust = copilotCliTrust(projectDir);
  if (trust.state === "unreadable") {
    return failure(
      `${trust.configPath} is not a Copilot CLI config AI-DLC can read, so the CLI's folder trust is unknown`,
      EXIT.failure,
      `repair ${trust.configPath} (valid JSON, comments allowed, trustedFolders as a list), then rerun ${configCommand("trust")}`,
    );
  }
  return success(
    trust.state === "trusted"
      ? "The Copilot CLI already trusts this folder"
      : trust.state === "absent"
      ? "No Copilot CLI config on this machine yet. Before using the Copilot CLI here (headless copilot -p runs included), run copilot in this folder once and choose \"Yes, and remember this folder for future sessions\"."
      : "The Copilot CLI has not trusted this folder. To trust it, run copilot in this folder once and choose \"Yes, and remember this folder for future sessions\".",
  );
}

function diagnosticSummary(
  section: DiagnosticSection,
  next: RuntimeRecord | ProvidersRecord | TrustRecord | null,
  harness: ModelHarness,
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
        !record
          ? "  Providers    reset to provider-neutral shipped bytes"
          : record.provider === "current"
          ? currentProviderSummary(harness)
          : record.provider === "builtin"
          ? "  Providers    legacy builtin answer; no provider settings written"
          : `  Providers    ${record.provider} region=${record.region ?? "manual"} profile=${
            record.profile ?? "default-chain"
          }`,
      ],
      notes: record
        ? pendingProviderIssues(record, harness).map((issue) => `${issue.id}: ${issue.message}`)
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
    const commands = [...new Set(actions.map((action) => action.step ?? action.command))];
    return `${base}\nOutstanding actions: ${commands.join("; ")}`;
  }
  return [
    base,
    "Outstanding actions:",
    ...actions.map((action) =>
      `  ${action.section}/${action.id}: ${action.message} - ${action.step ?? `run \`${action.command}\``}`
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
  return `${configInvocationFor()} config${args ? ` ${args}` : ""}`;
}

function commandToken(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function ranFromProject(projectDir: string): boolean {
  return normalizeDriveLetter(resolve(projectDir)) === normalizeDriveLetter(resolve(process.cwd()));
}

// A concrete follow-up command runs from the same shell, so it names the
// project whenever this command did not run from it.
function projectTarget(projectDir: string): string {
  return ranFromProject(projectDir)
    ? ""
    : ` --project-dir ${quoteCommandArgument(projectDir)}`;
}

// Whether two paths reach one file. File identity settles it, since one file
// has several spellings (a link, or a Windows 8.3 short name Bun's realpath
// keeps) and two files can differ only in case. A missing path reaches none.
function sameFile(left: string, right: string): boolean {
  try {
    const identity = fileIdentity(left);
    return identity.ino !== 0n && sameFileIdentity(identity, fileIdentity(right));
  } catch {
    return false;
  }
}

// The harness this config run sets up or refreshes, once it is known. No
// projection names one in the source tree, so the commands this run prints
// name this harness's tool there, not the first install the project shows.
let configTargetHarnessDir: string | null = null;

// How a printed command starts so it runs from where the user is: `aidlc`, or
// the Bun tool that ran this command. The project's own tool is named from the
// project when run there and by its path in the project when not. Any other
// tool (a runtime unpacked elsewhere, which may be adding a harness the project
// does not have yet) is named by its own path, unless it is the one under the
// working directory. In the source tree the project's own tool of the harness
// being set up stands in.
function configInvocationFor(projectDir = process.cwd()): string {
  const invocation = aidlcInvocation();
  if (invocation === "aidlc") return invocation;
  const ran = projectedDispatcher();
  // A projection's relative invocation names the harness directory it was
  // built for, whatever the environment says the harness is.
  const harnessDir = ran === null
    ? configTargetHarnessDir ?? runtimeHarnessDir()
    : basename(dirname(dirname(ran)));
  const toolIn = (root: string) => join(root, harnessDir, "tools", "aidlc.ts");
  if (ran === null || sameFile(ran, toolIn(projectDir))) {
    return ranFromProject(projectDir)
      ? ran === null ? `bun ${harnessDir}/tools/aidlc.ts` : invocation
      : `bun ${quoteCommandArgument(toolIn(projectDir))}`;
  }
  return sameFile(ran, toolIn(process.cwd())) ? invocation : `bun ${quoteCommandArgument(ran)}`;
}

// The command the user ran, printed again with the flags that resolve it, so
// it runs as shown from where they are.
function configRerunWith(
  input: readonly string[],
  projectDir: string,
  extra: readonly string[],
  dropValueFlags: readonly string[] = [],
): string | undefined {
  const invocation = configInvocationFor(projectDir);
  const args = stripVerb([...input]).filter((arg, index, all) =>
    !dropValueFlags.includes(arg) && !dropValueFlags.includes(all[index - 1] ?? "")
  );
  if (args.some(hasControlCharacters) || hasControlCharacters(projectDir)) return undefined;
  const additions = extra.filter((flag) => !args.includes(flag));
  const target = args.includes("--project-dir") ? "" : projectTarget(projectDir);
  return [
    invocation,
    "config",
    ...args.map((arg) => quoteCommandArgument(arg)),
    ...additions,
  ].join(" ") + target;
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

function configPrompt(fullLabel: string): string | null {
  // A long prompt wraps like any row; its last line is the prompt itself, laid
  // out two columns short so the cursor and the first typed character land
  // right after the prompt text on that line.
  const width = menuWidth();
  const lines = width === Number.POSITIVE_INFINITY
    ? [fullLabel]
    : menuLines("", fullLabel.split("\n"), width - 2);
  const label = lines.pop() ?? "";
  for (const line of lines) process.stdout.write(`${line}\n`);
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
  return readTerminalLine(label);
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
  const shellOnly = runtime.length > 0 ? [] : shellOnlyRuntimes(projectDir, harnessDir, modelHarness(distribution));
  const trust = outstanding.filter((action) => action.section === "trust");
  const providers = outstanding.filter((action) => action.section === "providers");
  const workspace = outstanding.filter((action) => action.section === "workspace");
  // Harness-owned model access is complete regardless of a legacy answer.
  const providerManaged = !harnessOwnsModelAccess(modelHarness(distribution));
  // Where the session sets every agent, there is no policy to ask for: the
  // row names the host's session as the lever and is never walked.
  const sessionSet = sessionSetsAgentModels(modelHarness(distribution));
  const sessionAccess = records.providers === null &&
    providerAnswerIsTheSession(modelHarness(distribution));
  const providerNeeds = providerManaged && !sessionAccess &&
    (providers.length > 0 || records.providers === null);
  const modelsUnrecorded = !sessionSet && (!policy || modelPolicyIsEmpty(policy));
  const modelDetail = sessionSet
    ? sessionModelsDetail(modelHarness(distribution), policy)
    : !policy || modelPolicyIsEmpty(policy)
    ? "no recorded policy; agents inherit your session model and effort"
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
  // Copilot in VS Code gates hooks on switches AI-DLC cannot read, so the row
  // names them as the person's to check instead of reporting all trust as met.
  const copilot = modelHarness(distribution) === "copilot";
  const trustDetail = trust.length === 1 && (trust[0].id === "copilot-folder-untrusted" || trust[0].step)
    ? trust[0].message
    : trust.length > 0
    ? `${trust.length} host trust issue${trust.length === 1 ? "" : "s"}`
    : copilot
    ? `${
      copilotCliTrust(projectDir).state === "absent"
        ? "no Copilot CLI config yet (the CLI asks to trust the folder on its first run)"
        : "no Copilot CLI trust issue"
    }; in VS Code, check the folder is trusted and Chat: Use Hooks is on`
    : records.trust?.reviewed
    ? "review acknowledged"
    : "no unmet host trust";
  const providerDetail = !providerManaged
    ? `model access comes with ${projectionProductName(root, distribution)}; nothing for AI-DLC to configure`
    : sessionAccess
    ? sessionProvidersDetail(
      modelHarness(distribution),
      `\`${configCommandForHarness(harnessDir, "providers")}\``,
    )
    : records.providers === null
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
      section: "models",
      needs: modelsUnrecorded,
    },
    {
      label: "Runtime",
      detail: runtime.length > 0
        ? runtime[0].message
        : shellOnly.length > 0
        ? `${shellOnly.join(" and ")} on this shell's PATH only: start ${projectionProductName(root, distribution)} from a terminal`
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
    // No `section`: the walk has no wizard for a missing shell, so this row is
    // shown and carried into the ledger without being offered as a step.
    {
      label: "Workspace",
      detail: workspace.length > 0
        ? "aidlc/spaces/default/memory/ is missing; the shell is incomplete"
        : "workspace shell present",
      needs: workspace.length > 0,
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
    writeMenuRow(`    ${renderedState}  ${row.label.padEnd(11)} `, row.detail);
  }
  const order: SetupWalkSection[] = ["models", "runtime", "providers", "trust"];
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
    if (action.step) writeMenuRow(`    ${action.section.padEnd(12)} `, action.step);
    else writeCommandRow(`    ${action.section.padEnd(12)} `, action.command);
  }
}

// An existing projection whose `aidlc/` workspace shell never arrived fails the
// doctor's "workspace shell ready" check. The interactive rerun surfaced it only
// as a Trust issue whose remedy, like the doctor's, was `aidlc config`, the
// command the user had just run, and it never repaired anything. Report it as
// its own row with the command that rebuilds the shell: an explicit `--harness`
// refresh, which bypasses this walk and goes through the refresh transaction.
function workspaceShellActions(
  projectDir: string,
  installed: { harnessDir: string; distribution: string },
): ConfigOutstandingAction[] {
  if (existsSync(memoryDirFor(projectDir, DEFAULT_SPACE))) return [];
  return [{
    section: "workspace",
    id: "workspace-shell-missing",
    message:
      "aidlc/spaces/default/memory/ is missing, so the workspace shell is incomplete " +
      "and rule loading resolves nothing.",
    command: workspaceShellRefreshCommand(
      installed.harnessDir,
      installed.distribution,
    ),
  }];
}

// Everything the setup map and ledger report for an existing projection. The
// Trust section already reports a missing `aidlc/` root as
// `workspace-root-missing`; when the Workspace row owns that state, drop the
// Trust copy so one defect is counted once and carries one remedy.
function existingProjectionOutstanding(
  projectDir: string,
  installed: { harnessDir: string; distribution: string },
): ConfigOutstandingAction[] {
  const workspace = workspaceShellActions(projectDir, installed);
  const others = postApplyOutstandingActions(
    projectDir,
    installed.harnessDir,
    modelHarness(installed.distribution),
  );
  return [
    ...(workspace.length > 0
      ? others.filter((action) => action.id !== "workspace-root-missing")
      : others),
    ...workspace,
  ];
}

// What setup and `config providers --check` say where no answer means the
// session's own model access (providerAnswerIsTheSession).
function sessionProvidersDetail(harness: ModelHarness, command: string): string {
  // Cursor takes Bedrock keys only in the IDE; its CLI always uses Cursor's backend.
  const where = harness === "cursor" ? " in the Cursor IDE" : "";
  return `${sessionModelAccessFact(harness)}; ` +
    `to use your own Amazon Bedrock access${where} instead, run ${command}`;
}

function setupLedgerActions(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  actions: readonly ConfigOutstandingAction[],
): ConfigOutstandingAction[] {
  const next = [...actions];
  if (
    !sessionSetsAgentModels(harness) &&
    !next.some((action) => action.section === "models")
  ) {
    const resolved = resolveAidlcSettings(projectDir);
    const policy = modelPolicyForHarness(resolved.models, harness);
    if (!policy || modelPolicyIsEmpty(policy)) {
      next.push({
        section: "models",
        id: "models-policy-unrecorded",
        message:
          "No model policy is recorded, so every agent inherits your session model and effort. " +
          "Record a preset, or choose unchanged to keep it that way.",
        command: configCommandForHarness(harnessDir, "models"),
      });
    }
  }
  if (next.some((action) => action.section === "providers")) return next;
  try {
    const record = readConfigDiagnosticRecords(
      join(projectDir, harnessDir),
    ).providers;
    // Only chase a missing answer where AI-DLC configures the model provider.
    // Asking a subscription-harness user to "choose and configure a model
    // provider" is a instruction they cannot complete and never needed.
    if (record === null && !harnessOwnsModelAccess(harness) && !providerAnswerIsTheSession(harness)) {
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
    modelHarness(distribution),
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
  // Reported, never walked: while the shell is incomplete no section is offered,
  // because the record-only children go through the projection the shell
  // belongs to and either fail on the missing directory or, when every answer
  // is a no-op, rebuild nothing. The ledger leads with the rebuild command.
  const shellMissing = initialOutstanding.some((action) => action.section === "workspace");
  if (flagged.length === 0 || shellMissing) {
    if (shellMissing) {
      process.stdout.write("\n");
      writeMenuRow(
        "  ",
        "The workspace shell is incomplete, so no section is walked until it is rebuilt; run the workspace command first.",
      );
    }
    if (initialLedger.length > 0) {
      renderSetupLedger(initialLedger);
    }
    return;
  }
  let answer: boolean;
  try {
    answer = promptYesDefault(
      `\n  Fix the ${flagged.length} sections that need you now?`,
      true,
    );
  } catch (error) {
    if (!(error instanceof FirstRunCancelled)) throw error;
    process.stdout.write(noAnswerLines(error, configCommand(projectTarget(projectDir))));
    process.exitCode = EXIT.usage;
    return;
  }
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
  // Recompute the same list the map was built from, shell included, so the
  // closing ledger never drops a row the map showed.
  const remaining = setupLedgerActions(
    projectDir,
    harnessDir,
    modelHarness(distribution),
    existingProjectionOutstanding(projectDir, { harnessDir, distribution }),
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
  if (section === "providers" && harnessOwnsModelAccess(selected.harness) && !hasMutationFlags) {
    // The fact line is human prose: `--json` must stay a single parseable
    // object and `--quiet` a single line, so only the human mode prints it.
    if (options.mode === "human") {
      const product = projectionProductName(selected.root, selected.distribution);
      process.stdout.write(`  ${ownedModelAccessFact(product)} Nothing to answer.\n`);
    }
    emitResult(
      success(`providers needs no answer for ${selected.harness}; its model access is harness-managed`),
      options,
    );
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
    if (section === "trust" && selected.harness === "copilot") {
      emitResult(copilotTrustStep(projectDir), options);
      return null;
    }
    next = diagnosticWizard(section, projectDir, selected, records, options);
  }
  const previous = currentDiagnosticRecord(records, section);
  const providerSurfaceDrift =
    section === "providers" &&
    next !== null &&
    providerSurfaceIssues(
      projectDir,
      selected.harnessDir,
      selected.harness,
      next as ProvidersRecord,
    ).some((issue) => issue.severity !== "warn");
  if (canonical(previous) === canonical(next) && !providerSurfaceDrift) {
    emitResult(success(`${section} configuration unchanged`), options);
    return null;
  }
  let confirm: PendingConfirm | undefined;
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
    confirm = {
      question: `Apply ${section} configuration changes?`,
      cancelled: `${section} configuration change cancelled`,
    };
  }
  const summary = diagnosticSummary(section, next, selected.harness);
  return {
    argv: diagnosticPipelineArgv(argv),
    context: {
      confirm,
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
        "--question-retention-days",
        "--swarm",
      ])
    : new Set([
        "--completions",
        "--from",
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
  const download = validateDownloadArgs(argv, section === "project");
  if (download) return download;
  const grammar = validateConfigOptionGrammar(argv, section, {
    ...withDownloadGrammar(argv, { values, bare }),
    repeatable: section === "flags"
      ? new Set(["--bypass", "--clear-bypass"])
      : undefined,
    invalidKnownMessage: (flag) => `${flag} is not valid for config ${section}`,
  });
  if (grammar) return grammar;
  // Nobody is there to ask for a check off on an unattended run. Turning one
  // back on is always done.
  if (section === "flags" && process.env.AIDLC_UNATTENDED === "1" && valuesAfter(argv, "--bypass").length > 0) {
    return "An unattended run does not turn a check off (AIDLC_UNATTENDED=1 is set): run it from an attended session.";
  }
  const mutationFlags = section === "flags"
    ? [
        "--bypass",
        "--clear-bypass",
        "--default-scope",
        "--hook-debug",
        "--reset",
        "--sensor-timeout-ms",
        "--question-retention-days",
        "--swarm",
      ]
    : ["--completions", "--mcp", "--plugins", "--reset"];
  return validateConfigMutationModes(argv, section, mutationFlags) ??
    (section === "flags" ? validateSettingsTargets(argv) : null);
}

function choiceHelp(section: ChoiceSection): string {
  const invoke = configInvocationFor();
  const out = process.stdout;
  const specific = section === "flags"
    ? [
        heading("Recorded flags:", out),
        "  --default-scope <installed-scope>",
        "  --swarm <on|off>",
        "  --hook-debug <on|off>",
        "  --sensor-timeout-ms <positive-integer>",
        "  --question-retention-days <days|unlimited>",
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
        "In an installed project a bypass needs none: --bypass records in aidlc.settings.local.json, and --clear-bypass clears every file that records it.",
      ]
    : [
        heading("Project choices:", out),
        "  --plugins <comma-separated-installed-names|all>",
        "  --mcp <defaults|none>",
        "  --completions <bash|zsh|fish|powershell|none>",
        "  --from <path>   release files to use instead of downloading: aidlc-copy-runtime-X.Y.Z.tar.gz, its runtime/ folder, or one harness root such as a checkout's dist/<harness>/",
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
    "  --download   fetch and verify the release this project needs (its pin, else its current version) when it is not on this machine; --release-base-url and --ca-bundle choose the source",
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
  const keptValues = new Set(["--from", "--harness", "--plan-token", "--project-dir", ...DOWNLOAD_VALUE_FLAGS]);
  const keptBare = new Set([
    "--download",
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
  const retention = valueAfter(argv, "--question-retention-days");
  if (retention === "unlimited") {
    delete next.questionRetentionDays;
  } else if (retention !== undefined) {
    const parsed = Number(retention);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        "--question-retention-days must be a positive integer or unlimited",
      );
    }
    next.questionRetentionDays = parsed;
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
      ["AIDLC_QUESTION_RETENTION_DAYS", "questionRetentionDays"],
    ].map(([envName, field]) => [
      envName,
      Object.hasOwn(process.env, envName)
        ? "env"
        : settingsSource(resolved, `flags.${field}`),
    ]));
    for (const bypass of RECORDABLE_PROJECT_BYPASSES) {
      sources[bypass] = Object.hasOwn(process.env, bypass)
        ? "env"
        : settingsSource(resolved, `flags.bypasses.${bypass}`);
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
      switches: switchesOffLines(projectDir, process.env, "command"),
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
  if (options.mode !== "human") {
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
    output += `  Question retention days: ${
      sources.AIDLC_QUESTION_RETENTION_DAYS === "env"
        ? effective.AIDLC_QUESTION_RETENTION_DAYS ?? "unlimited"
        : resolved.flags?.questionRetentionDays ?? "unlimited"
    } ${sourceLabel("AIDLC_QUESTION_RETENTION_DAYS")}\n`;
    for (const bypass of resolved.flags?.bypasses ?? []) {
      output += `  Bypass enabled: ${bypass} ${sourceLabel(bypass)}\n`;
    }
    for (const line of data.switches as string[]) output += `  ${line}\n`;
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
    const retention = configPrompt(
      "Question retention days [positive integer/unlimited, Enter keep]:",
    )?.trim();
    if (retention) args.push("--question-retention-days", retention);
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
        "--question-retention-days",
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
  // A bypass belongs to the project, not to one harness, so with several
  // harnesses installed a bypass change goes on without naming one. Any other
  // flags change still needs the harness, checked once the change is known.
  let harnessAmbiguity: unknown = null;
  let selected: ReturnType<typeof selectedDiagnosticHarness>;
  try {
    selected = selectedDiagnosticHarness(
      projectDir,
      valueAfter(argv, "--harness"),
      section,
    );
  } catch (error) {
    const installed = discoverProjectHarnesses(projectDir);
    if (
      section !== "flags" || !hasMutationFlags || installed.length < 2 ||
      valueAfter(argv, "--harness") !== undefined || argv.includes("--default-scope")
    ) {
      throw error;
    }
    harnessAmbiguity = error;
    selected = { ...installed[0], harness: modelHarness(installed[0].distribution) };
  }
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
  let keepPresentServers = false;
  let settings: SettingsMutation | undefined;
  const bypassTargets = section === "flags" && hasMutationFlags
    ? bypassSettingsTargets(argv, projectDir, selected.root)
    : null;
  // A clear that reaches several files changes each of them.
  const extraSettings = (bypassTargets ?? []).slice(1).map((layer) =>
    flagsMutationFor(argv, projectDir, selected.root, layer)
  );
  const target = section === "flags" && (hasMutationFlags || configInputIsTty())
    ? bypassTargets?.[0] ?? settingsTargetForMutation(argv, projectDir)
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
      // Servers a release shipped that the project already has stay on until
      // the person turns them off.
      if (valueAfter(argv, "--mcp") === undefined && records.project?.mcp === undefined) {
        const descriptor = siblingDescriptor(selected);
        if (descriptor && holdsShippedServers(projectDir, descriptor)) {
          built.record.mcp = "defaults";
          keepPresentServers = true;
        }
      }
      next = built.record;
      nextPlugins = built.plugins;
      mcpMode = built.record.mcp;
    }
  } else {
    if (!configInputIsTty()) {
      const flags = section === "flags"
        ? "--default-scope, --swarm, --hook-debug, --sensor-timeout-ms, --question-retention-days, --bypass, or --reset"
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
      extraSettings,
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
  const bypassOnly = section === "flags" && bypassOnlyRequest(argv, settings);
  if (harnessAmbiguity !== null && !bypassOnly) throw harnessAmbiguity;
  let confirm: PendingConfirm | undefined;
  // A bypass or clear-bypass is done as typed: no question and no --yes.
  if (!argv.includes("--dry-run") && !options.yes && !bypassOnly) {
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
    confirm = {
      question: `Apply ${section} configuration changes?`,
      cancelled: `${section} configuration change cancelled`,
    };
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
      confirm,
      section,
      distribution: selected.distribution,
      ...(harnessAmbiguity !== null ? { anyHarness: true as const } : {}),
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
      ...(keepPresentServers ? { keepPresentServers: true as const } : {}),
      summaryLines: summary.lines,
      notes: summary.notes,
      ...(settings ? { settings } : {}),
      ...(extraSettings.length > 0 ? { extraSettings } : {}),
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

function siblingBaseline(sibling: ProjectHarness): Baseline | null {
  try {
    return readBaseline(join(sibling.root, "tools", "data", "aidlc-manifest.json"));
  } catch {
    return null;
  }
}

// The provider choice recorded in a projection's harness data.
function recordedProviders(root: string, harnessDir: string): ProvidersRecord | null {
  try {
    const data = JSON.parse(readFileSync(join(root, harnessDir, "tools", "data", "harness.json"), "utf-8")) as Record<string, unknown>;
    return normalizeProvidersRecord(data.providers);
  } catch {
    return null;
  }
}

function siblingDescriptor(sibling: ProjectHarness): Pick<ProjectionDescriptor, "rootIntegrations"> | null {
  try {
    const path = join(sibling.root, "tools", "data", "aidlc-projection.json");
    if (!regularFile(path)) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(value) || !Array.isArray(value.rootIntegrations)) return null;
    return {
      rootIntegrations: readRootIntegrations(value.rootIntegrations) as ProjectionDescriptor["rootIntegrations"],
    };
  } catch {
    return null;
  }
}

// Kiro CLI's agent-v1 row and the KAS row project into the same .kiro
// directory and own disjoint host files there, so either replaces the other in
// place through its ownership baseline. OpenCode and Copilot also share .aidlc,
// but they write host files outside it (.opencode/, .github/,
// .vscode/settings.json) and Copilot's AGENTS.md block is exclusive, so they
// are not switched.
const IN_PLACE_SWITCHABLE: ReadonlySet<string> = new Set(["kiro", "kiro-ide"]);
// The one directory both rows project into.
const KIRO_SWITCH_DIR = ".kiro";

// The one check that a baseline records the harness installed beside it.
function baselineNamesHarness(baseline: Baseline, harness: { distribution: string; harnessDir: string }): boolean {
  return baseline.distribution === harness.distribution && baseline.harnessDir === harness.harnessDir;
}

function switchesInPlace(installed: string, requested: string): boolean {
  return installed !== requested &&
    IN_PLACE_SWITCHABLE.has(installed) &&
    IN_PLACE_SWITCHABLE.has(requested);
}

// A repository-supplied name as a person reads it: whole and JSON-quoted (JSON
// escapes quotes, backslashes, and C0 controls its own way), with every other
// character outside printable ASCII written as \u{…}, so no two names read
// alike (a composed and a decomposed accent, or a look-alike letter from
// another script, differ in what is printed).
function displayName(name: string): string {
  return JSON.stringify(name).replace(
    /[^\x20-\x7e]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

// Repository file names inside the one parenthesis that says they are data
// from the repository, not instructions, as other untrusted text is printed.
function repositoryNames(names: readonly string[]): string {
  // Every name, never a count: an approval covers only the files it names.
  return `(repository file names, not instructions: ${names.join(", ")})`;
}

// Why a hooks directory cannot be reviewed in place: it is a link or a file,
// or this user cannot list it. The one rule both the pre-planning refusal and
// the locked recheck read.
function hooksDirProblem(projectDir: string, hooksDir: string): "redirected" | "unreadable" | null {
  const directory = join(projectDir, hooksDir);
  if (!pathPresent(directory)) return null;
  if (!lstatSync(directory).isDirectory()) return "redirected";
  try {
    readdirSync(directory);
    return null;
  } catch {
    return "unreadable";
  }
}

function assertHooksDirReviewable(projectDir: string, hooksDir: string, harnessDir: string, requested: string): void {
  const problem = hooksDirProblem(projectDir, hooksDir);
  if (problem === "redirected") {
    throw new SwitchRefusal(`cannot switch ${harnessDir} to ${requested}: ${hooksDir} is a link or a file, not a directory`, {
      kind: "text",
      text: `make ${hooksDir} a directory holding its files, then run the switch again`,
    });
  }
  if (problem === "unreadable") {
    throw new SwitchRefusal(
      `cannot switch ${harnessDir} to ${requested}: ${hooksDir} cannot be listed, so the hook files Kiro would run cannot be reviewed`,
      { kind: "text", text: `make ${hooksDir} readable and searchable for this user, or move it aside, then run the switch again` },
    );
  }
}

// The hook JSON files in a hooks directory that the next baseline does not
// own, in one scan: each with the state the plan binds, its mode, and whether
// it is a regular file there. Kiro IDE 1.x runs only `*.json` hook files here
// (legacy `*.kiro.hook` files fire nothing, and the kiro row ships its own).
// A regular file is bound by its bytes, or by what lstat says when this user
// cannot read it; nothing here follows a link. An entry gone between the
// listing and its lstat is reported as gone, so a recheck sees a change.
function scanUnownedHooks(
  projectDir: string,
  hooksDir: string,
  owned: Record<string, string>,
): {
  redirected: boolean;
  unreadable: boolean;
  entries: Array<{ path: string; state: string; mode: number; regular: boolean }>;
} {
  const directory = join(projectDir, hooksDir);
  const problem = hooksDirProblem(projectDir, hooksDir);
  if (problem || !pathPresent(directory)) {
    return { redirected: problem === "redirected", unreadable: problem === "unreadable", entries: [] };
  }
  const entries = readdirSync(directory)
    .filter((name) => /\.json$/i.test(name))
    .sort()
    .map((name) => `${hooksDir}/${name}`)
    .filter((rel) => !Object.hasOwn(owned, rel))
    .map((rel) => {
      const path = join(projectDir, rel);
      try {
        const stat = lstatSync(path);
        let state: string;
        try {
          state = stat.isFile() ? transactionState(path) : `entry:${entryIdentity(path)}`;
        } catch {
          state = `unhashed:${entryIdentity(path)}`;
        }
        return { path: rel, state, mode: stat.mode & 0o777, regular: stat.isFile() };
      } catch {
        return { path: rel, state: "gone", mode: 0, regular: false };
      }
    });
  return { redirected: false, unreadable: false, entries };
}

// The steps that record a usable baseline, as one line: move a damaged file
// aside by its path in the project, then refresh the installed row. With
// nothing before it the line is the refresh command alone, so it can be run as
// printed.
function switchRefreshSteps(
  projectDir: string,
  remedy: { harness: string; moveAside?: string },
): string {
  const refresh = `${configInvocationFor(projectDir)} config --harness ${remedy.harness}${projectTarget(projectDir)}`;
  return remedy.moveAside
    ? `move ${join(projectDir, remedy.moveAside)} aside, then run \`${refresh}\``
    : refresh;
}

export function _switchRefreshStepsForTests(
  projectDir: string,
  remedy: { harness: string; moveAside?: string },
): string {
  return switchRefreshSteps(projectDir, remedy);
}

// A switch refusal names the config run that gets past it: a refresh of the
// installed row, the switch with --harness, this run without --dry-run, or
// (for a newer release's baseline) the update that comes first. The
// handler renders it with this invocation's command form and project target,
// so every output mode prints it.
type SwitchRemedy =
  | { kind: "refresh"; harness: string; moveAside?: string }
  | { kind: "switch"; harness: string }
  | { kind: "update" }
  | { kind: "text"; text: string };

class SwitchRefusal extends Error {
  constructor(message: string, readonly remedy: SwitchRemedy) {
    super(message);
  }
}

const isStringMap = (value: unknown): boolean =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

// The one shape check for an ownership baseline a switch plans from.
function baselineShapeProblem(value: Baseline): string | null {
  if (typeof value.frameworkVersion !== "string") return "frameworkVersion is not a string";
  if (typeof value.distribution !== "string") return "distribution is not a string";
  if (typeof value.harnessDir !== "string") return "harnessDir is not a string";
  if (value.shippedOnly !== undefined && value.shippedOnly !== true) return "shippedOnly is not true";
  if (value.mcpMode !== "defaults" && value.mcpMode !== "none") return "mcpMode is not defaults or none";
  if (!isStringMap(value.files)) return "files is not a map of hashes";
  if (value.entries !== undefined && !(isRecord(value.entries) && Object.values(value.entries).every(isStringMap))) {
    return "entries is not a map of hash maps";
  }
  if (!isRecord(value.rootContributions)) return "rootContributions is not a map of contributions";
  for (const [path, entry] of Object.entries(value.rootContributions)) {
    if (!contributionValid(entry)) return `rootContributions[${JSON.stringify(path)}] is not a valid contribution`;
  }
  return null;
}

// One check per RootContribution variant, optional fields included.
function contributionValid(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const optionalString = (field: unknown) => field === undefined || typeof field === "string";
  switch (entry.policy) {
    case "managed-block":
      return typeof entry.hash === "string" && optionalString(entry.marker);
    case "json-map":
      return isStringMap(entry.entries) && optionalString(entry.key);
    case "json-array":
      return isStringMap(entry.entries) && typeof entry.key === "string";
    case "whole-file":
      return typeof entry.hash === "string";
    case "jsonc-settings":
      return isStringMap(entry.entries) &&
        (entry.added === undefined || (Array.isArray(entry.added) && entry.added.every((key) => typeof key === "string"))) &&
        (entry.created === undefined || typeof entry.created === "boolean");
    case "json-entries":
      return isStringMap(entry.entries) && (entry.created === undefined || typeof entry.created === "boolean");
    default:
      return false;
  }
}

// What lstat says about an entry itself, for one whose bytes cannot be read.
// It never opens or reads into the entry.
function entryIdentity(path: string): string {
  const stat = lstatSync(path);
  return `${stat.mode}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

// Without a usable occupant baseline nothing says which of its files are
// AI-DLC's, so the files only it ships would be left behind. The switch never
// changes the baseline itself: every refusal here leaves the project as it is
// and names the steps that record a usable one: moving a damaged file aside,
// then the stock refresh of the installed row, which picks its source as any
// refresh does.
function assertSwitchBaseline(occupant: ProjectHarness, requested: string): void {
  const rel = `${occupant.harnessDir}/tools/data/aidlc-manifest.json`;
  const path = join(occupant.root, "tools", "data", "aidlc-manifest.json");
  const lead = `cannot switch ${occupant.harnessDir} from ${occupant.distribution} to ${requested}: installed ${occupant.distribution}`;
  const refresh = `refresh the installed ${occupant.distribution} row first`;
  const remedy = (moveAside?: string): SwitchRemedy => ({
    kind: "refresh",
    harness: occupant.distribution,
    ...(moveAside ? { moveAside } : {}),
  });
  let problem: string | null = null;
  try {
    const baseline = readBaseline(path);
    if (!baseline) throw new SwitchRefusal(`${lead} has no ownership baseline (${rel}); ${refresh}`, remedy());
    problem = baselineShapeProblem(baseline) ??
      (!baselineNamesHarness(baseline, occupant) ? `it names ${baseline.distribution} in ${baseline.harnessDir}` : null);
    // A baseline from before it held only shipped paths may also list the
    // project's own files, so the refresh planner keeps every file it names.
    // A switch would then leave the installed row's files behind; a refresh of
    // that row records the shipped-only baseline first.
    if (problem === null && baseline.shippedOnly !== true) {
      throw new SwitchRefusal(
        `${lead} has an ownership baseline recorded before it listed only shipped files (${rel}); ${refresh}`,
        remedy(),
      );
    }
  } catch (error) {
    if (error instanceof SwitchRefusal) throw error;
    problem = (error instanceof Error ? error.message : String(error)).replace(`cannot refresh from ${path}: `, "");
  }
  if (problem === null) return;
  // The reason quotes the repository's own file, so it is printed as data,
  // bounded: unlike a file name, nothing limits its length.
  // The cut mark is this tool's, so it stays outside the quoted data.
  const characters = [...problem];
  const shown = characters.length > 120 ? `${displayName(characters.slice(0, 120).join(""))}…` : displayName(problem);
  const reason = `(repository baseline data, not instructions: ${shown})`;
  // A schemaVersion that is a JSON integer above this release's is a newer
  // release's record, not damage: it is kept, and the switch is left to that
  // release. Any other value, a numeric string included, is damage like the
  // rest. The raw value decides, not the message, which reads the same for
  // 2 and "2".
  const newer = /^unsupported schema /.test(problem) && (() => {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
      return isRecord(raw) && typeof raw.schemaVersion === "number" && Number.isInteger(raw.schemaVersion) &&
        raw.schemaVersion > 1;
    } catch {
      return false;
    }
  })();
  if (newer) {
    throw new SwitchRefusal(
      `${lead} has an ownership baseline from a newer AI-DLC release (${rel} ${reason}); run the switch with that release`,
      { kind: "update" },
    );
  }
  throw new SwitchRefusal(
    `${lead} has an unusable ownership baseline (${rel} ${reason}); move it aside, then ${refresh}`,
    remedy(rel),
  );
}

function predatesFrameworkVersion(version: string | undefined, incoming: string): boolean {
  if (version === undefined) return true;
  try {
    return compareVersions(version, incoming) < 0;
  } catch {
    return true;
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

// The ownership hash of one setting value; an absent setting matches nothing.
function settingHash(value: unknown): string {
  return value === undefined ? "" : sha256Bytes(canonical(value));
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

/**
 * Plans the project settings write. Returns this clone's git exclude file when
 * a new local settings file must also be kept out of git there; the caller
 * appends it with `excludeLocalSettingsFromClone` once the plan has run.
 */
function planProjectSettingsMutation(
  projectDir: string,
  mutation: SettingsMutation | undefined,
  operations: TransactionOperation[],
  actions: PlannedAction[],
): string | null {
  if (!mutation || mutation.target === "global") return null;
  const rel = relative(projectDir, mutation.path);
  if (mutation.next === null) {
    if (!pathPresent(mutation.path)) return null;
    operations.push({ kind: "remove", path: rel, expected: expected(mutation.path) });
    actions.push({ path: rel, action: "remove" });
    return null;
  }
  const creating = !pathPresent(mutation.path);
  operations.push(writeOperation(
    rel,
    serializeAidlcSettings(mutation.next),
    expected(mutation.path),
  ));
  actions.push({ path: rel, action: creating ? "create" : "update" });
  if (mutation.target !== "local" || !creating) return null;
  // AI-DLC's managed .gitignore block lists the local file. An install from
  // before it did keeps the file out of git through this clone's own exclude
  // list instead, so recording a setting never edits the team's .gitignore,
  // which is their source.
  const gitignorePath = join(projectDir, ".gitignore");
  const gitignore = regularFile(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (gitignore.split(/\r?\n/).includes(LOCAL_SETTINGS_FILE)) return null;
  // This project's own clone: git's repository-redirect variables would point
  // the lookup at another one. A linked worktree's list is in the shared dir.
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  const located = spawnSync("git", ["-C", projectDir, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
    env,
    timeout: 10_000,
  });
  if (located.status !== 0 || !located.stdout.trim()) return null;
  const exclude = join(resolve(projectDir, located.stdout.trim()), "info", "exclude");
  if (regularFile(exclude) && readFileSync(exclude, "utf-8").split(/\r?\n/).includes(LOCAL_SETTINGS_FILE)) {
    return null;
  }
  const shown = relative(projectDir, exclude);
  actions.push({
    path: shown.startsWith("..") || isAbsolute(shown) ? exclude : shown.replaceAll("\\", "/"),
    action: regularFile(exclude) ? "update" : "create",
    detail: `ignore ${LOCAL_SETTINGS_FILE} in this clone`,
  });
  return exclude;
}

// A personal settings file git does not ignore only shows as untracked, so a
// failure here never undoes the settings change: it comes back as a one-line
// note instead. The list and its folder must be git's own, a real folder and a
// regular file (or none yet), never a link that sends the write elsewhere, and
// the new list replaces the old one atomically.
function excludeLocalSettingsFromClone(exclude: string | null): string | null {
  if (exclude === null) return null;
  try {
    const info = dirname(exclude);
    if (pathPresent(info) && !lstatSync(info).isDirectory()) throw new Error(`${info} is not a folder`);
    if (pathPresent(exclude) && !lstatSync(exclude).isFile()) throw new Error(`${exclude} is not a regular file`);
    const current = pathPresent(exclude) ? readFileSync(exclude, "utf-8") : "";
    if (current.split(/\r?\n/).includes(LOCAL_SETTINGS_FILE)) return null;
    mkdirSync(info, { recursive: true });
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    writeFileAtomic(exclude, `${current}${separator}${LOCAL_SETTINGS_FILE}\n`);
    return null;
  } catch (error) {
    return `${LOCAL_SETTINGS_FILE} is not ignored by git in this clone (${
      error instanceof Error ? error.message : String(error)
    }); add it to .gitignore to keep it out of commits.`;
  }
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
  projectChecks: Pick<TransactionOptions, "validateLocked" | "validateCommitted"> = {},
): void {
  const operation = globalSettingsOperation(mutation);
  if (!operation || !mutation) {
    executePlan(projectPlan, projectChecks);
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
    executePlan(projectPlan, projectChecks);
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
  return regenerated.has(normalized) || unbaselinedGenerated(harnessDir).includes(normalized);
}

// Written by the engine from project state, so never recorded as shipped: a
// refresh writes the staged copy over whatever is there, and never reports it
// as a local change. Kiro IDE's steering file carries the project's memory text
// (aidlc-includes.ts kiroIdeSteering).
function unbaselinedGenerated(harnessDir: string): string[] {
  return [
    `${harnessDir}/tools/data/harness.json`,
    `${harnessDir}/tools/data/stage-graph.json`,
    `${harnessDir}/tools/data/scope-grid.json`,
    ...(harnessDir === ".kiro" ? [KIRO_IDE_STEERING] : []),
  ];
}

// Compose records a plugin's consumed artifacts as objects, so the sidecar
// shape must match what the compose hook writes, or the readers below silently
// match nothing. See issue #1247.
type ConsumeContribRecord = {
  artifact: string;
  required: boolean;
  conditional_on?: string;
};

type StageContribRecord = {
  produces?: string[];
  sensors?: string[];
  consumes?: Array<string | ConsumeContribRecord>;
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
    const names = new Set(
      record.consumes.map((entry) => typeof entry === "string" ? entry : entry.artifact),
    );
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

// Keys the installed source owns: a refresh takes them from the new tree, not
// the project's copy. `name` and `kiroLayout` belong here with `distribution`:
// a project moved to another row that kept its old name or layout would still
// read as the old row to every reader that keys on them.
const HARNESS_IDENTITY_KEYS = new Set([
  "schemaVersion",
  "distribution",
  "name",
  "kiroLayout",
  "productName",
  "configNextStep",
  "hookActivation",
  "directiveMaxBytes",
  "harnessDir",
  "rulesSubdir",
]);

const CLAUDE_SHIPPED_KEYS = [
  "companyAnnouncements",
  "permissions",
  "statusLine",
  "hooks",
];

// Exact Claude dist bytes present in version tags before these direct hooks
// were retired. A manifestless file is removable only when its hash is here;
// names, imports, and other source heuristics never establish ownership.
const RELEASED_LEGACY_CLAUDE_HOOK_HASHES: Readonly<Record<string, ReadonlySet<string>>> = {
  "audit-logger": new Set([
    "sha256:064eac85c2f71d9832fc93c65a36b22a0af795539b349c9400952d25c66647f7",
    "sha256:3294da0207cf7d18e48872ffc2efbfb910baacbd4ba18392807a731e9cac801a",
  ]),
  "mint-presence": new Set([
    "sha256:ff7556c56f6bebe0bc447be6632ccc34d14bb68b11220ad8e36bfd0bc37d2b90",
  ]),
  "runtime-compile": new Set([
    "sha256:8a54c7bad431576d829597ecfa02447a74d13e09d0fb878fc37a69e0486efd6a",
    "sha256:f1bb53cfefb4d9be8b238dbcd080001dc8d68a5a3c120459b0eb73670d63c965",
    "sha256:fc754dd871fb86b94ca870b486dc0ed2f3bd842168ffa95655f6dfc2d93c7838",
  ]),
  "sensor-fire": new Set([
    "sha256:c88f3c8817ad5864b895185858d9006fb81ebf50644ac3f160a8bbd10c0a0a51",
    "sha256:fe4d6f041236d5a3f04c6dd7da78beb9afaef02c0543ba49e77853441a714d79",
  ]),
  stop: new Set([
    "sha256:00cfdd6fb288ed3b1317dd0b1fd7b5850992683f9d1fea96b8eee3b3695d3cb5",
    "sha256:3cdb0888452c13c1706490be0c9b4948ae0a73d0fdc09ff1aff8ee00b1158fe8",
    "sha256:4aee4a7bc1d8b6bc9ad50513630e2f3d37ab44e7cea810d756a0355c881d07fa",
    "sha256:71fb8ef269917355b6bbd37392df751947283e54af6fe437552e24d6c63253cc",
  ]),
  "sync-statusline": new Set([
    "sha256:35a7c593e6f05768bc92ceaa9596f4112aecad8c8820a5e9f7b32eb090f9871e",
    "sha256:549109978d1f335cc1ac530a1381f06b0d5dab29edbeff72565563d8cc66d682",
  ]),
};

function preserveClaudeProviderFields(
  projectDir: string,
  stagedRoot: string,
  harnessDir: string,
  previousProvider: ProvidersRecord | null,
  nextProvider: ProvidersRecord | null,
  projectFlags: ProjectFlagsRecord | null,
  prior: Baseline | null,
  notes: string[],
): Set<string> {
  const retiredManagedFiles = new Set<string>();
  const relative = `${harnessDir}/settings.json`;
  const currentPath = join(projectDir, relative);
  const stagedPath = join(stagedRoot, relative);
  if (!regularFile(currentPath) || !regularFile(stagedPath)) return retiredManagedFiles;
  const currentText = readFileSync(currentPath, "utf-8");
  const current = JSON.parse(withoutBom(currentText)) as Record<string, unknown>;
  const staged = readJsonFile(stagedPath) as Record<string, unknown>;
  const priorEntries = prior?.entries?.[relative];
  const incomingHookHashes = aidlcHookRegistrationHashes(staged.hooks);
  const recordedHookTargets = Object.keys(priorEntries ?? {})
    .filter((key) => key.startsWith(AIDLC_HOOK_ENTRY_PREFIX))
    .map((key) => key.slice(AIDLC_HOOK_ENTRY_PREFIX.length));
  const registeredLegacyTargets = new Set<string>();
  for (const groups of Object.values(isRecord(current.hooks) ? current.hooks : {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const item of group.hooks) {
        if (!isRecord(item) || typeof item.command !== "string") continue;
        const target = legacyAidlcHookTarget(item.command);
        if (target !== null) registeredLegacyTargets.add(target);
      }
    }
  }
  const attributableLegacyTargets = [...registeredLegacyTargets].filter((target) => {
    const hookRelative = `${harnessDir}/hooks/aidlc-${target}.ts`;
    if (prior?.files[hookRelative] !== undefined) return true;
    if (prior !== null) return false;
    const hookPath = join(projectDir, hookRelative);
    if (!regularFile(hookPath)) return false;
    const released = RELEASED_LEGACY_CLAUDE_HOOK_HASHES[target];
    return released?.has(sha256FileMatching(hookPath, [...(released ?? [])])) ?? false;
  });
  const ownedHookTargets = new Set([
    ...Object.keys(incomingHookHashes),
    ...recordedHookTargets,
    ...attributableLegacyTargets,
  ]);
  if (prior === null) {
    for (const target of attributableLegacyTargets) {
      if (Object.hasOwn(incomingHookHashes, target)) continue;
      const hookRelative = `${harnessDir}/hooks/aidlc-${target}.ts`;
      if (!regularFile(join(stagedRoot, hookRelative))) {
        retiredManagedFiles.add(hookRelative);
      }
    }
  }
  // Start with the shipped object's key order so a pristine refresh is byte-identical.
  if (canonical(current.hooks) !== canonical(staged.hooks)) {
    const currentOwnedHooks = aidlcHookRegistrations(
      current.hooks,
      ownedHookTargets,
      projectDir,
    );
    const currentOwnedHash = sha256Bytes(canonical(currentOwnedHooks));
    const hadLocalHookDrift = priorEntries?.hooksAidlc !== undefined
      ? currentOwnedHash !== priorEntries.hooksAidlc
      : priorEntries?.hooks !== undefined
      ? currentOwnedHash !== priorEntries.hooks
      : canonical(currentOwnedHooks) !==
        canonical(aidlcHookRegistrations(staged.hooks, ownedHookTargets));
    if (hadLocalHookDrift) {
      // A settings file the project wrote before AI-DLC has none of its hooks yet.
      notes.push(Object.keys(currentOwnedHooks).length === 0
        ? "added the AI-DLC hook registrations to .claude/settings.json; your own settings were kept."
        : "restored the AI-DLC hook registrations in .claude/settings.json (they had been changed); your own hook entries were kept.");
    }
    const hooks = isRecord(staged.hooks) ? { ...staged.hooks } : {};
    for (const [event, groups] of Object.entries(isRecord(current.hooks) ? current.hooks : {})) {
      if (!Array.isArray(groups)) continue;
      const userGroups = groups.flatMap((group: unknown) => {
        if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
        const items = group.hooks.filter((item: unknown) =>
          !isRecord(item) || typeof item.command !== "string" ||
          !ownedHookTargets.has(aidlcHookTarget(item.command, projectDir) ?? "")
        );
        return items.length > 0 ? [{ ...group, hooks: items }] : [];
      });
      if (userGroups.length > 0) {
        hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...userGroups];
      }
    }
    staged.hooks = hooks;
  }
  const permissions = isRecord(current.permissions) ? current.permissions : {};
  const shippedPermissions = isRecord(staged.permissions) ? staged.permissions : {};
  const shippedAllow = Array.isArray(shippedPermissions.allow) ? shippedPermissions.allow : [];
  const userAllow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (shippedAllow.some((entry: unknown) => !userAllow.includes(entry))) {
    notes.push(
      "added the AI-DLC command allow entries that were missing from .claude/settings.json; your other permissions were kept.",
    );
  }
  staged.permissions = {
    ...permissions,
    allow: [...shippedAllow, ...userAllow.filter((entry: unknown) => !shippedAllow.includes(entry))],
  };
  // A kept personal value is reported only when this release ships a different
  // value than the one recorded last time; otherwise the choice stands silently.
  const shippedChanged = (key: string): boolean =>
    priorEntries?.[key] === undefined ||
    sha256Bytes(canonical(staged[key])) !== priorEntries[key];
  if (
    Object.hasOwn(current, "statusLine") &&
    isCustomClaudeStatusLine(current.statusLine, projectDir)
  ) {
    if (shippedChanged("statusLine")) {
      notes.push(
        "kept your statusLine in .claude/settings.json; this release ships a different one. Delete the key and refresh to take it.",
      );
    }
    staged.statusLine = current.statusLine;
  }
  // A value equal to this release's own is AI-DLC's, not the person's: a
  // copied runtime brings it in before the first setup records anything.
  if (
    Object.hasOwn(current, "companyAnnouncements") &&
    sha256Bytes(canonical(current.companyAnnouncements)) !== priorEntries?.companyAnnouncements &&
    canonical(current.companyAnnouncements) !== canonical(staged.companyAnnouncements)
  ) {
    if (shippedChanged("companyAnnouncements")) {
      notes.push(
        "kept your companyAnnouncements in .claude/settings.json; this release ships a different one. Delete the key and refresh to take it.",
      );
    }
    staged.companyAnnouncements = current.companyAnnouncements;
  }
  for (const [key, value] of Object.entries(current)) {
    if (key === "env") continue;
    // Every other top-level setting belongs to the project.
    if (!CLAUDE_SHIPPED_KEYS.includes(key)) {
      staged[key] = value;
    }
  }
  const currentEnv = current.env && typeof current.env === "object" &&
      !Array.isArray(current.env)
    ? { ...current.env as Record<string, unknown> }
    : {};
  const currentLegacy = hasLegacyClaudeProviderConfig(currentEnv);
  if (
    previousProvider?.provider === "amazon-bedrock" ||
    currentEnv.CLAUDE_CODE_USE_BEDROCK === "1"
  ) {
    stripLegacyClaudeModelAliases(currentEnv);
  }
  if (
    previousProvider?.provider === "amazon-bedrock" &&
    currentEnv.CLAUDE_CODE_USE_BEDROCK === "1" &&
    currentEnv.AWS_REGION === previousProvider.region &&
    (!previousProvider.profile ||
      currentEnv.AWS_PROFILE === previousProvider.profile)
  ) {
    delete currentEnv.CLAUDE_CODE_USE_BEDROCK;
    delete currentEnv.AWS_REGION;
    if (previousProvider.profile) delete currentEnv.AWS_PROFILE;
  } else if (currentLegacy) {
    delete currentEnv.CLAUDE_CODE_USE_BEDROCK;
    delete currentEnv.AWS_REGION;
  }
  const stagedEnv = staged.env && typeof staged.env === "object" &&
      !Array.isArray(staged.env)
    ? { ...staged.env as Record<string, unknown> }
    : {};
  if (nextProvider?.provider !== "amazon-bedrock") {
    const stagedLegacy = hasLegacyClaudeProviderConfig(stagedEnv);
    if (
      previousProvider?.provider === "amazon-bedrock" ||
      stagedEnv.CLAUDE_CODE_USE_BEDROCK === "1"
    ) {
      stripLegacyClaudeModelAliases(stagedEnv);
    }
    if (
      previousProvider?.provider === "amazon-bedrock" &&
      stagedEnv.CLAUDE_CODE_USE_BEDROCK === "1" &&
      stagedEnv.AWS_REGION === previousProvider.region &&
      (!previousProvider.profile ||
        stagedEnv.AWS_PROFILE === previousProvider.profile)
    ) {
      delete stagedEnv.CLAUDE_CODE_USE_BEDROCK;
      delete stagedEnv.AWS_REGION;
      if (previousProvider.profile) delete stagedEnv.AWS_PROFILE;
    } else if (stagedLegacy) {
      delete stagedEnv.CLAUDE_CODE_USE_BEDROCK;
      delete stagedEnv.AWS_REGION;
    }
  }
  // A recorded project flag owns this value. Without one, preserve the
  // documented direct settings.json customization during unrelated refreshes.
  if (projectFlags?.defaultScope) {
    delete currentEnv.AWS_AIDLC_DEFAULT_SCOPE;
  }
  staged.env = { ...stagedEnv, ...currentEnv };
  writeFileSync(stagedPath, jsonFileText(staged, currentText));
  return retiredManagedFiles;
}

const CODEX_FRAMEWORK_TABLES = new Set([
  "shell_environment_policy",
  "sandbox_workspace_write",
  "agents",
  "features",
  "tools",
  "tui",
]);

const CODEX_FRAMEWORK_ASSIGNMENTS = [
  {
    name: "developer_instructions",
    pattern:
      /[\t ]*developer_instructions[\t ]*=[\t ]*'''[\s\S]*?'''[\t ]*(?:\r?\n|$)/y,
  },
  {
    name: "sandbox_mode",
    pattern: /[\t ]*(?:sandbox_mode|"sandbox_mode"|'sandbox_mode')[\t ]*=[^\r\n]*(?:\r?\n|$)/y,
  },
  {
    name: "suppress_unstable_features_warning",
    pattern:
      /[\t ]*(?:suppress_unstable_features_warning|"suppress_unstable_features_warning"|'suppress_unstable_features_warning')[\t ]*=[^\r\n]*(?:\r?\n|$)/y,
  },
  // The raised output budget: without it Codex cuts a long workflow instruction
  // short for a model outside its catalog.
  {
    name: "tool_output_token_limit",
    pattern:
      /[\t ]*(?:tool_output_token_limit|"tool_output_token_limit"|'tool_output_token_limit')[\t ]*=[^\r\n]*(?:\r?\n|$)/y,
  },
] as const;

// Match only real root assignments, not lookalikes in onboarding prose, arrays,
// or user-owned tables. TOML tables keep their scope through blank lines.
function codexFrameworkAssignmentMatch(content: string, pattern: RegExp): RegExpExecArray | null {
  let lineStart = true;
  let depth = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === "\n") { lineStart = true; continue; }
    if (char === " " || char === "\t" || char === "\r") continue;
    if (char === "#") {
      const end = content.indexOf("\n", index);
      if (end === -1) break;
      index = end - 1;
      continue;
    }
    if (lineStart && depth === 0) {
      if (char === "[") return null;
      pattern.lastIndex = index;
      const match = pattern.exec(content);
      if (match) return match;
    }
    lineStart = false;
    if (char === '"' || char === "'") {
      const delimiter = content.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += delimiter.length;
      while (index < content.length && !content.startsWith(delimiter, index)) {
        if (char === '"' && content[index] === "\\") index++;
        index++;
      }
      index += delimiter.length - 1;
    } else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
  }
  return null;
}

function codexFrameworkAssignments(
  content: string,
): Array<{ name: string; text: string }> {
  return CODEX_FRAMEWORK_ASSIGNMENTS.flatMap(({ name, pattern }) => {
    const text = codexFrameworkAssignmentMatch(content, pattern)?.[0]
      .replaceAll("\r\n", "\n")
      .trimEnd();
    return text === undefined ? [] : [{ name, text }];
  });
}

function codexSections(
  content: string,
): Array<{ name: string; text: string }> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ name: string; text: string }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (table !== undefined) {
      if (current) {
        sections.push({
          name: current.name,
          text: current.lines.join("\n").trimEnd(),
        });
      }
      current = { name: table, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) {
    sections.push({
      name: current.name,
      text: current.lines.join("\n").trimEnd(),
    });
  }
  return sections;
}

// A TOML table header or assignment with its exact source range and full key
// path. Comments and blank lines belong to no statement, so an edit never moves
// them. `table` is the header an assignment sits under ([] at the root);
// `comment` says the statement's own lines carry a comment, `innerComment` that
// one sits inside its value (a multi-line array).
type TomlStatement = {
  kind: "header" | "assignment";
  path: string[];
  table: string[];
  // A header or assignment inside an array of tables: never AI-DLC's.
  arrayTable: boolean;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  comment: boolean;
  innerComment: boolean;
};

// The key path a TOML key or header spells (quoted, escaped and dotted forms
// alike), read by parsing it.
function tomlParsedPath(text: string): string[] | null {
  try {
    let value: unknown = Bun.TOML.parse(text);
    const path: string[] = [];
    while (isRecord(value) && Object.keys(value).length === 1) {
      const key = Object.keys(value)[0];
      path.push(key);
      value = value[key];
    }
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

// The index of a key's `=` from `from`, outside quotes and before `limit` or the
// line end; -1 when there is none.
function tomlKeyEquals(content: string, from: number, limit = content.length): number {
  for (let index = from; index < limit; index++) {
    const char = content[index];
    if (char === "\n") return -1;
    if (char === "=") return index;
    if (char === '"' || char === "'") {
      index++;
      while (index < limit && content[index] !== char && content[index] !== "\n") {
        if (char === '"' && content[index] === "\\") index++;
        index++;
      }
    }
  }
  return -1;
}

// The span of one TOML value starting after `=` at `from`. A statement value
// ends at the line end outside strings and brackets; a member of an inline table
// ends before its `,` or `}`. `end` is past the statement's line end.
function tomlValueSpan(
  content: string,
  from: number,
  member: boolean,
  limit = content.length,
): { valueStart: number; valueEnd: number; end: number; comment: boolean; inner: boolean } | null {
  let index = from;
  while (index < limit && (content[index] === " " || content[index] === "\t")) index++;
  const valueStart = index;
  let valueEnd = index;
  let depth = 0;
  let comment = false;
  let inner = false;
  while (index < limit) {
    const char = content[index];
    if (depth === 0 && member && (char === "," || char === "}")) {
      return { valueStart, valueEnd, end: index, comment, inner };
    }
    if (char === "\n") {
      if (depth === 0 && !member) return { valueStart, valueEnd, end: index + 1, comment, inner };
      index++;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      index++;
      continue;
    }
    if (char === "#") {
      comment = true;
      if (depth > 0) inner = true;
      while (index < limit && content[index] !== "\n") index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const delimiter = content.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += delimiter.length;
      for (;;) {
        if (index >= limit) return null;
        if (char === '"' && content[index] === "\\") {
          index += 2;
          continue;
        }
        if (content.startsWith(delimiter, index)) {
          // Up to two quotes may close the content right before the delimiter.
          for (let extra = 0; extra < 2 && delimiter.length === 3 && content[index + 3] === char; extra++) {
            index++;
          }
          break;
        }
        if (delimiter.length === 1 && content[index] === "\n") return null;
        index++;
      }
      index += delimiter.length;
      valueEnd = index;
      continue;
    }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    if (depth < 0) return null;
    index++;
    valueEnd = index;
  }
  return depth === 0 && !member ? { valueStart, valueEnd, end: limit, comment, inner } : null;
}

// Every table header and assignment of a TOML file, in order; null when a line
// cannot be read, so the caller never edits what it did not understand.
function tomlStatements(content: string): TomlStatement[] | null {
  const statements: TomlStatement[] = [];
  let table: string[] = [];
  let arrayTable = false;
  let index = 0;
  while (index < content.length) {
    const lineStart = index;
    while (index < content.length && (content[index] === " " || content[index] === "\t")) index++;
    const char = content[index];
    if (index >= content.length) break;
    if (char === "\n" || char === "\r" || char === "#") {
      const newline = content.indexOf("\n", index);
      index = newline < 0 ? content.length : newline + 1;
      continue;
    }
    if (char === "[") {
      const newline = content.indexOf("\n", index);
      const end = newline < 0 ? content.length : newline + 1;
      const line = content.slice(lineStart, end);
      const path = tomlParsedPath(`${line.trimEnd()}\n`);
      if (path === null) return null;
      table = path;
      arrayTable = content.startsWith("[[", index);
      statements.push({
        kind: "header", path, table: [], arrayTable,
        start: lineStart, end, valueStart: end, valueEnd: end,
        // A header name holds no `#` outside quotes, so one here opens a comment.
        comment: /#/.test(line.replace(/"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g, "")),
        innerComment: false,
      });
      index = end;
      continue;
    }
    const equals = tomlKeyEquals(content, index);
    if (equals < 0) return null;
    const key = tomlParsedPath(`${content.slice(index, equals)}= 0\n`);
    const value = tomlValueSpan(content, equals + 1, false);
    if (key === null || value === null) return null;
    statements.push({
      kind: "assignment", path: [...table, ...key], table, arrayTable,
      start: lineStart, end: value.end, valueStart: value.valueStart, valueEnd: value.valueEnd,
      comment: value.comment,
      innerComment: value.inner,
    });
    index = value.end;
  }
  return statements;
}

// The value span of `path` inside the inline table spanning valueStart..valueEnd.
function tomlInlineMemberSpan(
  content: string,
  valueStart: number,
  valueEnd: number,
  path: readonly string[],
): { start: number; end: number; innerComment: boolean } | null {
  if (content[valueStart] !== "{" || content[valueEnd - 1] !== "}") return null;
  const close = valueEnd - 1;
  let index = valueStart + 1;
  while (index < close) {
    while (index < close && /[\s,]/.test(content[index])) index++;
    if (index >= close) break;
    const equals = tomlKeyEquals(content, index, close);
    if (equals < 0) return null;
    const key = tomlParsedPath(`${content.slice(index, equals)}= 0\n`);
    const value = tomlValueSpan(content, equals + 1, true, close + 1);
    if (key === null || value === null) return null;
    if (pathStartsWith(path, key)) {
      return key.length === path.length
        ? { start: value.valueStart, end: value.valueEnd, innerComment: value.inner }
        : tomlInlineMemberSpan(content, value.valueStart, value.valueEnd, path.slice(key.length));
    }
    index = value.end;
  }
  return null;
}

// The span of the value that defines `path`: its own assignment, wherever the
// file puts it, or its member inside an enclosing inline table.
function tomlValueSpanOf(
  content: string,
  statements: readonly TomlStatement[],
  path: readonly string[],
): { start: number; end: number; innerComment: boolean; statement: TomlStatement } | null {
  for (const statement of statements) {
    if (statement.kind !== "assignment" || statement.arrayTable) continue;
    if (!pathStartsWith(path, statement.path)) continue;
    if (statement.path.length === path.length) {
      return {
        start: statement.valueStart,
        end: statement.valueEnd,
        innerComment: statement.innerComment,
        statement,
      };
    }
    const member = tomlInlineMemberSpan(
      content,
      statement.valueStart,
      statement.valueEnd,
      path.slice(statement.path.length),
    );
    return member ? { ...member, statement } : null;
  }
  return null;
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, at) => part === path[at]);
}

// A key path as TOML spells it: bare parts where allowed, quoted otherwise.
function tomlKey(path: readonly string[]): string {
  return path.map((part) => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join(".");
}

function tomlPathValue(
  root: unknown,
  path: readonly string[],
): { found: boolean; value: unknown; clash: boolean } {
  let value: unknown = root;
  for (const part of path) {
    if (value === undefined) return { found: false, value: undefined, clash: false };
    if (!isTomlTable(value)) return { found: false, value: undefined, clash: true };
    value = Object.hasOwn(value, part) ? value[part] : undefined;
  }
  return { found: value !== undefined, value, clash: false };
}

// A TOML table as parsed: a plain object. Dates and times parse to other objects.
function isTomlTable(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Values compare as TOML values (the parser already reads a CRLF line end inside
// a multi-line string as one line end). Paths in `skip` are left out, and tables
// they leave empty with them.
function codexValueText(value: unknown, skip: ReadonlySet<string> = new Set(), path: string[] = []): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => codexValueText(item)).join(",")}]`;
  if (isTomlTable(value)) {
    const members = Object.keys(value).sort().flatMap((key) => {
      const child = [...path, key];
      if (skip.has(JSON.stringify(child))) return [];
      const text = codexValueText(value[key], skip, child);
      return skip.size > 0 && text === "{}" && isTomlTable(value[key]) ? [] : [`${JSON.stringify(key)}:${text}`];
    });
    return `{${members.join(",")}}`;
  }
  if (value !== null && typeof value === "object") return JSON.stringify(`${value.constructor?.name}:${String(value)}`);
  return JSON.stringify(value);
}

const CODEX_VALUE_ENTRY_PREFIX = "value:";
const CODEX_SPACE_POINTER = JSON.stringify(["shell_environment_policy", "set", "AIDLC_RULES_DIR"]);
const CODEX_SPACE_MEMORY = /^aidlc\/spaces\/[^/"\\]+\/memory$/;

function codexValueEntry(path: readonly string[]): string {
  return `${CODEX_VALUE_ENTRY_PREFIX}${JSON.stringify(path)}`;
}

// AI-DLC's own settings in config.toml: each leaf key under the shipped root
// assignments and framework tables, by full path. A project table under one of
// those roots (an [agents.<name>] role) is never one of them.
function codexFrameworkLeaves(shipped: Record<string, unknown>): string[][] {
  const leaves: string[][] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (isTomlTable(value) && Object.keys(value).length > 0) {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    } else {
      leaves.push(path);
    }
  };
  for (const { name } of CODEX_FRAMEWORK_ASSIGNMENTS) {
    if (Object.hasOwn(shipped, name)) leaves.push([name]);
  }
  for (const name of CODEX_FRAMEWORK_TABLES) {
    if (isTomlTable(shipped[name])) walk(shipped[name], [name]);
  }
  return leaves;
}

function codexFrameworkValueEntries(config: string): Array<[string, string]> {
  const shipped = Bun.TOML.parse(config) as Record<string, unknown>;
  return codexFrameworkLeaves(shipped).map((path) => [
    codexValueEntry(path),
    sha256Bytes(codexValueText(tomlPathValue(shipped, path).value)),
  ]);
}

// The hashes a baseline from before per-value records holds, read from real
// statements: per root assignment, and per top-level table section from its
// header to the next real header (a table a later release retires included).
function legacyCodexEntryHashes(
  content: string,
  statements: readonly TomlStatement[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const statement of statements) {
    if (statement.kind !== "assignment" || statement.table.length !== 0 || statement.path.length !== 1) continue;
    if (Object.hasOwn(hashes, statement.path[0])) continue;
    const key = statement.start + (/^[\t ]*/.exec(content.slice(statement.start, statement.end))?.[0].length ?? 0);
    hashes[statement.path[0]] = sha256Bytes(content.slice(key, statement.end).replaceAll("\r\n", "\n").trimEnd());
  }
  const headers = statements.filter((statement) => statement.kind === "header");
  for (const [at, header] of headers.entries()) {
    const name = header.path.length === 1 && !header.arrayTable ? header.path[0] : null;
    if (name === null || Object.hasOwn(hashes, name)) continue;
    const text = content.slice(header.start, headers[at + 1]?.start ?? content.length)
      .replaceAll("\r\n", "\n")
      .trimEnd();
    hashes[name] = sha256Bytes(text);
  }
  return hashes;
}

function plainList(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Refresh AI-DLC's own settings in the project's config.toml and keep every byte
// of the project's: its keys (also inside AI-DLC's tables), its tables, comments,
// blank lines, order and spelling. A value of AI-DLC's nobody changed takes the
// release's; a value the project changed stays theirs; a deleted one comes back;
// a retired one goes while it still holds what AI-DLC wrote. Returns null when
// the file cannot be merged and proven, so the caller falls back.
function mergeCodexEntries(
  staged: string,
  currentFile: string,
  priorEntries: Record<string, string> | undefined,
  pristine: boolean,
  label: string,
): { content: string; notes: string[] } | null {
  // Anything the merge fails to read or prove (a crafted file included) leaves
  // the file to the whole-table fallback.
  try {
    return planCodexEntries(staged, currentFile, priorEntries, pristine, label);
  } catch {
    return null;
  }
}

function planCodexEntries(
  staged: string,
  currentFile: string,
  priorEntries: Record<string, string> | undefined,
  pristine: boolean,
  label: string,
): { content: string; notes: string[] } | null {
  const bom = currentFile.startsWith("\uFEFF") ? "\uFEFF" : "";
  const current = currentFile.slice(bom.length);
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = (text: string): string => text.replaceAll("\r\n", "\n").replaceAll("\n", newline);
  const stagedObject = Bun.TOML.parse(staged) as Record<string, unknown>;
  const currentObject = Bun.TOML.parse(current) as Record<string, unknown>;
  const stagedStatements = tomlStatements(staged);
  const currentStatements = tomlStatements(current);
  if (stagedStatements === null || currentStatements === null) return null;

  const recorded = priorEntries ?? {};
  // No record at all: a baseline from before entries, where an untouched file is
  // all AI-DLC's, or a file AI-DLC never wrote.
  const unrecorded = Object.keys(recorded).length === 0;
  const perValue = Object.keys(recorded).some((key) => key.startsWith(CODEX_VALUE_ENTRY_PREFIX));
  const legacyCurrent = perValue ? {} : legacyCodexEntryHashes(current, currentStatements);
  const legacyStaged = perValue ? {} : legacyCodexEntryHashes(staged, stagedStatements);
  const leaves = codexFrameworkLeaves(stagedObject);
  const expected = new Map<string, unknown>();
  const sets: string[][] = [];
  const putBack: string[] = [];
  const kept: string[] = [];
  for (const leaf of leaves) {
    const target = tomlPathValue(stagedObject, leaf).value;
    const now = tomlPathValue(currentObject, leaf);
    if (now.clash || (now.found && isTomlTable(now.value) !== isTomlTable(target))) return null;
    const key = JSON.stringify(leaf);
    const legacyKey = leaf[0];
    const record = perValue ? recorded[codexValueEntry(leaf)] : recorded[legacyKey];
    const same = now.found && codexValueText(now.value) === codexValueText(target);
    const spacePointer = now.found && key === CODEX_SPACE_POINTER &&
      typeof now.value === "string" && CODEX_SPACE_MEMORY.test(now.value) &&
      typeof target === "string" && CODEX_SPACE_MEMORY.test(target);
    if (same || spacePointer) {
      expected.set(key, now.value);
      continue;
    }
    if (!now.found) {
      if (!pristine && record !== undefined && (perValue || legacyCurrent[legacyKey] === undefined)) {
        putBack.push(tomlKey(leaf));
      }
      sets.push(leaf);
      expected.set(key, target);
      continue;
    }
    // The record says what AI-DLC last wrote. A key it never recorded is the
    // project's, unless no record exists at all and the file is untouched.
    const unedited = unrecorded
      ? pristine
      : record !== undefined &&
        (perValue ? record === sha256Bytes(codexValueText(now.value)) : legacyCurrent[legacyKey] === record);
    if (unedited) {
      sets.push(leaf);
      expected.set(key, target);
      continue;
    }
    // The project's own value stays; say so only when this release ships another.
    const shippedChanged = record === undefined ||
      (perValue ? record !== sha256Bytes(codexValueText(target)) : legacyStaged[legacyKey] !== record);
    if (shippedChanged) kept.push(tomlKey(leaf));
    expected.set(key, now.value);
  }

  // Retired: recorded, no longer shipped, and still holding what AI-DLC wrote.
  const shippedLeaves = new Set(leaves.map((leaf) => JSON.stringify(leaf)));
  const retired: string[][] = [];
  if (perValue) {
    for (const [entry, hash] of Object.entries(recorded)) {
      if (!entry.startsWith(CODEX_VALUE_ENTRY_PREFIX)) continue;
      const path = JSON.parse(entry.slice(CODEX_VALUE_ENTRY_PREFIX.length)) as string[];
      if (shippedLeaves.has(JSON.stringify(path))) continue;
      const now = tomlPathValue(currentObject, path);
      if (now.found && sha256Bytes(codexValueText(now.value)) === hash) retired.push(path);
    }
  } else {
    // An older baseline: a section exactly as recorded (or, with no record at
    // all, an untouched file) is AI-DLC's, so what this release no longer ships
    // in it goes.
    const ownedSection = (name: string): boolean => unrecorded
      ? pristine && (CODEX_FRAMEWORK_TABLES.has(name) ||
        CODEX_FRAMEWORK_ASSIGNMENTS.some((assignment) => assignment.name === name))
      : recorded[name] !== undefined && legacyCurrent[name] === recorded[name];
    for (const statement of currentStatements) {
      if (statement.kind !== "assignment" || statement.arrayTable) continue;
      const inSection = statement.table.length === 0 ? statement.path.length === 1 : statement.table.length === 1;
      if (!inSection || !ownedSection(statement.path[0])) continue;
      if (tomlPathValue(stagedObject, statement.path).found) continue;
      if (leaves.some((leaf) => pathStartsWith(leaf, statement.path))) continue;
      retired.push(statement.path);
    }
  }

  const edits: Array<{ start: number; end: number; text: string; order: number }> = [];
  const insertedStatements = new Set<number>();
  const appendedTables = new Set<string>();
  const appended: string[] = [];
  for (const leaf of sets) {
    const value = tomlValueSpanOf(staged, stagedStatements, leaf);
    if (value === null) return null;
    const valueText = lines(staged.slice(value.start, value.end));
    const existing = tomlValueSpanOf(current, currentStatements, leaf);
    if (existing !== null) {
      // A comment of the project's inside the old value would go with it.
      if (existing.innerComment) return null;
      edits.push({ start: existing.start, end: existing.end, text: valueText, order: edits.length });
      continue;
    }
    // Missing inside an inline table of the project's: add it as one more member.
    const inline = currentStatements.find((statement) =>
      statement.kind === "assignment" && !statement.arrayTable &&
      statement.path.length < leaf.length && pathStartsWith(leaf, statement.path)
    );
    if (inline) {
      if (inline.path.length !== leaf.length - 1 || current[inline.valueStart] !== "{") return null;
      const inner = current.slice(inline.valueStart + 1, inline.valueEnd - 1);
      const at = inline.valueStart + 1 + inner.trimEnd().length;
      const member = `${tomlKey(leaf.slice(inline.path.length))} = ${valueText}`;
      const lead = inner.trim() === "" || inner.trimEnd().endsWith(",") ? " " : ", ";
      edits.push({ start: at, end: at, text: `${lead}${member}`, order: edits.length });
      continue;
    }
    // Missing: add the shipped statement that defines it, once.
    const shippedStatement = value.statement;
    if (insertedStatements.has(shippedStatement.start)) continue;
    insertedStatements.add(shippedStatement.start);
    const statementPath = shippedStatement.path;
    if (currentStatements.some((statement) => pathStartsWith(statement.path, statementPath))) return null;
    const statementValue = lines(staged.slice(shippedStatement.valueStart, shippedStatement.valueEnd));
    if (statementPath.length === 1) {
      const text = lines(staged.slice(shippedStatement.start, shippedStatement.end).trimEnd());
      edits.push({ start: 0, end: 0, text: `${text}${newline}${newline}`, order: edits.length });
      continue;
    }
    const tableName = statementPath[0];
    const header = currentStatements.find((statement) =>
      statement.kind === "header" && !statement.arrayTable &&
      statement.path.length === 1 && statement.path[0] === tableName
    );
    if (header) {
      const section = currentStatements.slice(currentStatements.indexOf(header) + 1);
      const next = section.findIndex((statement) => statement.kind === "header");
      const body = next < 0 ? section : section.slice(0, next);
      const at = body.length > 0 ? body[body.length - 1].end : header.end;
      const lead = at === current.length && !current.endsWith("\n") ? newline : "";
      edits.push({
        start: at,
        end: at,
        text: `${lead}${tomlKey(statementPath.slice(1))} = ${statementValue}${newline}`,
        order: edits.length,
      });
      continue;
    }
    const rootDefined = currentStatements.filter((statement) =>
      statement.kind === "assignment" && statement.table.length === 0 &&
      statement.path[0] === tableName
    );
    if (rootDefined.length > 0) {
      const at = rootDefined[rootDefined.length - 1].end;
      edits.push({
        start: at,
        end: at,
        text: `${tomlKey(statementPath)} = ${statementValue}${newline}`,
        order: edits.length,
      });
      continue;
    }
    if (appendedTables.has(tableName)) continue;
    appendedTables.add(tableName);
    // Append the shipped table, with the comment lines right above its header.
    const shippedHeader = stagedStatements.find((statement) =>
      statement.kind === "header" && statement.path.length === 1 && statement.path[0] === tableName
    );
    if (!shippedHeader) return null;
    const shippedSection = stagedStatements.slice(stagedStatements.indexOf(shippedHeader) + 1);
    const shippedNext = shippedSection.findIndex((statement) => statement.kind === "header");
    const shippedBody = shippedNext < 0 ? shippedSection : shippedSection.slice(0, shippedNext);
    let from = shippedHeader.start;
    while (from > 0) {
      const previousStart = staged.lastIndexOf("\n", from - 2) + 1;
      if (!staged.slice(previousStart, from).trimStart().startsWith("#")) break;
      from = previousStart;
    }
    const to = shippedBody.length > 0 ? shippedBody[shippedBody.length - 1].end : shippedHeader.end;
    // One blank line before each appended table.
    const separator = appendedTables.size > 1
      ? newline
      : current.length === 0 || current.endsWith(`${newline}${newline}`)
      ? ""
      : current.endsWith("\n")
      ? newline
      : `${newline}${newline}`;
    appended.push(`${separator}${lines(staged.slice(from, to).trimEnd())}${newline}`);
  }
  // Appended tables come after anything added to the file's own last table.
  for (const text of appended) {
    edits.push({ start: current.length, end: current.length, text, order: edits.length });
  }
  // A retired setting goes with its line; a comment of the project's on that
  // line, or a setting inside an inline table, is not AI-DLC's to remove.
  const removed = new Set<TomlStatement>();
  for (const path of retired) {
    const existing = tomlValueSpanOf(current, currentStatements, path);
    if (existing === null) continue;
    if (existing.statement.path.length !== path.length || existing.statement.comment) return null;
    removed.add(existing.statement);
    edits.push({ start: existing.statement.start, end: existing.statement.end, text: "", order: edits.length });
  }
  // A retired table's header goes with its last setting.
  for (const [at, header] of currentStatements.entries()) {
    if (header.kind !== "header" || header.arrayTable || header.path.length !== 1) continue;
    if (isTomlTable(stagedObject[header.path[0]])) continue;
    const section = currentStatements.slice(at + 1);
    const next = section.findIndex((statement) => statement.kind === "header");
    const body = next < 0 ? section : section.slice(0, next);
    if (body.length === 0 || !body.every((statement) => removed.has(statement))) continue;
    if (header.comment) return null;
    edits.push({ start: header.start, end: header.end, text: "", order: edits.length });
  }

  // Apply from the end; edits at one offset keep the shipped order.
  edits.sort((left, right) => right.start - left.start || right.order - left.order);
  let merged = current;
  let limit = current.length;
  for (const edit of edits) {
    if (edit.end > limit) return null;
    merged = merged.slice(0, edit.start) + edit.text + merged.slice(edit.end);
    limit = edit.start;
  }

  // Prove the result before it is used: it parses, AI-DLC's settings hold what
  // was planned, and everything else equals the project's file.
  const mergedObject = Bun.TOML.parse(merged) as Record<string, unknown>;
  for (const leaf of leaves) {
    const got = tomlPathValue(mergedObject, leaf);
    if (!got.found || codexValueText(got.value) !== codexValueText(expected.get(JSON.stringify(leaf)))) {
      return null;
    }
  }
  for (const path of retired) if (tomlPathValue(mergedObject, path).found) return null;
  const owned = new Set([...leaves, ...retired].map((path) => JSON.stringify(path)));
  if (codexValueText(mergedObject, owned) !== codexValueText(currentObject, owned)) return null;

  const notes: string[] = [];
  if (unrecorded && !pristine && sets.length > 0 && current.trim() !== "") {
    notes.push(`added AI-DLC's settings to ${label}; your own settings were kept.`);
  } else if (putBack.length > 0) {
    notes.push(`put back AI-DLC's ${plainList(putBack)} in ${label}.`);
  }
  if (kept.length === 1) {
    notes.push(
      `kept your ${kept[0]} in ${label}; this release ships a different value. Delete the key and refresh to take it.`,
    );
  } else if (kept.length > 1) {
    notes.push(
      `kept your ${plainList(kept)} in ${label}; this release ships different values. Delete a key and refresh to take its shipped value.`,
    );
  }
  return { content: `${bom}${merged}`, notes };
}

function mergeCodexUserConfiguration(
  staged: string,
  current: string,
  priorEntries: Record<string, string> | undefined,
  pristine: boolean,
  notes: string[],
  label: string,
): { content: string; frameworkOwnedClean: boolean; proven: boolean } {
  const entries = mergeCodexEntries(staged, current, priorEntries, pristine, label);
  if (entries !== null) {
    notes.push(...entries.notes);
    return { content: entries.content, frameworkOwnedClean: true, proven: true };
  }
  // A file the per-entry merge cannot prove keeps the whole-table behaviour:
  // keep project model/provider assignments and custom tables, but always
  // stage framework tables from the release. Local drift in those tables
  // remains visible to the ownership planner.
  let merged = current;
  let frameworkOwnedClean = true;
  const generatedFrameworkAssignments = codexFrameworkAssignments(staged);
  const missingAssignments: string[] = [];
  for (const assignment of generatedFrameworkAssignments) {
    const definition = CODEX_FRAMEWORK_ASSIGNMENTS.find(
      ({ name }) => name === assignment.name,
    );
    if (!definition) continue;
    const existing = codexFrameworkAssignmentMatch(merged, definition.pattern);
    const currentText = existing?.[0].replaceAll("\r\n", "\n").trimEnd();
    const priorHash = priorEntries?.[assignment.name];
    const owned = priorHash
      ? currentText !== undefined && sha256Bytes(currentText) === priorHash
      : currentText === undefined || pristine;
    if (!owned) frameworkOwnedClean = false;
    if (currentText === assignment.text) continue;
    if (existing) {
      merged = merged.slice(0, existing.index) + `${assignment.text}\n` +
        merged.slice(existing.index + existing[0].length);
    } else {
      missingAssignments.push(assignment.text);
    }
  }
  if (missingAssignments.length > 0) {
    merged = `${missingAssignments.join("\n\n")}\n\n${merged.trimStart()}`;
  }
  const generatedFrameworkSections = codexSections(staged).filter((section) =>
    CODEX_FRAMEWORK_TABLES.has(section.name)
  );
  for (const section of generatedFrameworkSections) {
    const escaped = section.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `^[\\t ]*\\[${escaped}\\][\\t ]*(?:\\r?\\n|$)[\\s\\S]*?(?=^[\\t ]*\\[|(?![\\s\\S]))`,
      "m",
    );
    const existing = pattern.exec(merged)?.[0];
    const currentText = existing?.replaceAll("\r\n", "\n").trimEnd();
    const priorHash = priorEntries?.[section.name];
    const owned = priorHash
      ? currentText !== undefined && sha256Bytes(currentText) === priorHash
      : pristine;
    if (!owned) frameworkOwnedClean = false;
    if (currentText === section.text) continue;
    if (existing !== undefined) {
      merged = merged.replace(pattern, () => `${section.text}\n\n`);
    } else {
      merged = `${merged.trimEnd()}\n\n${section.text}\n`;
    }
  }
  return {
    content: merged.endsWith("\n") ? merged : `${merged}\n`,
    frameworkOwnedClean,
    proven: false,
  };
}

function preserveCodexProviderFields(
  projectDir: string,
  stagedRoot: string,
  harnessDir: string,
  prior: Baseline | null,
  notes: string[],
  unproven: Set<string>,
): boolean {
  const relative = `${harnessDir}/config.toml`;
  const currentPath = join(projectDir, relative);
  const stagedPath = join(stagedRoot, relative);
  if (!regularFile(currentPath) || !regularFile(stagedPath)) return false;
  const current = readFileSync(currentPath, "utf-8");
  const merged = mergeCodexUserConfiguration(
    readFileSync(stagedPath, "utf-8"),
    current,
    prior?.entries?.[relative],
    sha256Matching(current, [prior?.files[relative]]) === prior?.files[relative],
    notes,
    relative,
  );
  writeFileSync(stagedPath, merged.content);
  // A file this refresh wrote can hold the project's own keys inside AI-DLC's
  // tables, which the whole-table merge would drop: only --force replaces it.
  if (!merged.proven && merged.content !== current) unproven.add(relative);
  return merged.proven;
}

// True when the staged release merges opencode.json per entry: the team's
// provider block is then never copied into AI-DLC's part, so it is never read
// as AI-DLC's.
function stagedOpenCodeJsonEntries(stagedRoot: string): boolean {
  try {
    const descriptor = readJsonFile(join(stagedRoot, ".aidlc", "tools", "data", "aidlc-projection.json")) as {
      rootIntegrations?: unknown;
    };
    const integrations = readRootIntegrations(descriptor.rootIntegrations);
    return Array.isArray(integrations) && integrations.some((integration) =>
      isRecord(integration) && integration.path === "opencode.json" && integration.policy === "json-entries"
    );
  } catch {
    return false;
  }
}

function preserveOpenCodeProviderFields(
  projectDir: string,
  stagedRoot: string,
): void {
  const currentPath = join(projectDir, "opencode.json");
  const stagedPath = join(stagedRoot, "opencode.json");
  if (!regularFile(currentPath) || !regularFile(stagedPath) || stagedOpenCodeJsonEntries(stagedRoot)) return;
  const currentText = readFileSync(currentPath, "utf-8");
  const current = JSON.parse(withoutBom(currentText)) as Record<string, unknown>;
  if (!current.provider || typeof current.provider !== "object" ||
      Array.isArray(current.provider)) {
    // The release copy takes the mark the person's file has, so a mark alone
    // is never read as their change.
    const stagedText = readFileSync(stagedPath, "utf-8");
    if (currentText.startsWith("\uFEFF") && !stagedText.startsWith("\uFEFF")) {
      writeFileSync(stagedPath, `\uFEFF${stagedText}`);
    }
    return;
  }
  const staged = readJsonFile(stagedPath) as Record<string, unknown>;
  const stagedProviders = staged.provider && typeof staged.provider === "object" &&
      !Array.isArray(staged.provider)
    ? staged.provider as Record<string, unknown>
    : {};
  staged.provider = {
    ...stagedProviders,
    ...current.provider as Record<string, unknown>,
  };
  writeFileSync(stagedPath, jsonFileText(staged, currentText));
}

function preserveUserProviderFields(
  projectDir: string,
  stagedRoot: string,
  harnessDir: string,
  harness: ModelHarness,
  previousProvider: ProvidersRecord | null,
  nextProvider: ProvidersRecord | null,
  projectFlags: ProjectFlagsRecord | null,
  prior: Baseline | null,
  notes: string[],
  retiredManagedFiles: Set<string>,
  unproven: Set<string>,
): boolean {
  if (harness === "claude") {
    // Claude settings merge per entry, so the refreshed file always applies.
    for (const rel of preserveClaudeProviderFields(
      projectDir,
      stagedRoot,
      harnessDir,
      previousProvider,
      nextProvider,
      projectFlags,
      prior,
      notes,
    )) retiredManagedFiles.add(rel);
    return true;
  } else if (harness === "codex") {
    return preserveCodexProviderFields(projectDir, stagedRoot, harnessDir, prior, notes, unproven);
  } else if (harness === "opencode") {
    preserveOpenCodeProviderFields(projectDir, stagedRoot);
  }
  return true;
}

function unrecordedLegacyProviderMigration(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  previousProvider: ProvidersRecord | null,
): { path: string; region: string } | null {
  if (previousProvider !== null) return null;
  if (harness === "claude") {
    const relative = `${harnessDir}/settings.json`;
    const path = join(projectDir, relative);
    if (!regularFile(path)) return null;
    const settings = readJsonFile(path) as Record<string, unknown>;
    const env = settings.env && typeof settings.env === "object" &&
        !Array.isArray(settings.env)
      ? settings.env as Record<string, unknown>
      : {};
    return hasLegacyClaudeProviderConfig(env) && typeof env.AWS_REGION === "string"
      ? { path: relative, region: env.AWS_REGION }
      : null;
  }
  if (harness === "codex") {
    const relative = `${harnessDir}/config.toml`;
    const path = join(projectDir, relative);
    return regularFile(path) &&
        hasLegacyCodexProviderConfig(readFileSync(path, "utf-8"))
      ? { path: relative, region: "us-east-1" }
      : null;
  }
  return null;
}

function prepareRefreshSource(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  modelPolicy: ModelPolicyRecord | null,
  projectFlags: ProjectFlagsRecord | null,
  recordOnly: boolean,
  projectProjection: boolean,
  diagnosticsOverride?: ConfigDiagnosticOverrides,
): PreparedRefreshSource {
  // A copied project is not a release: never baseline the user's edits as
  // shipped entries during an in-place record mutation.
  const entries: Baseline["entries"] = projectProjection ? prior?.entries : {};
  const notes: string[] = [];
  if (!projectProjection && entries && descriptor.distribution === "claude") {
    const rel = `${descriptor.harnessDir}/settings.json`;
    const settings = JSON.parse(readFileSync(join(sourceRoot, rel), "utf-8")) as Record<string, unknown>;
    entries[rel] = Object.fromEntries(
      CLAUDE_SHIPPED_KEYS.filter((key) => Object.hasOwn(settings, key))
        .map((key) => [key, sha256Bytes(canonical(settings[key]))]),
    );
    entries[rel].hooksAidlc = sha256Bytes(canonical(aidlcHookRegistrations(settings.hooks)));
    for (const [target, hash] of Object.entries(aidlcHookRegistrationHashes(settings.hooks))) {
      entries[rel][`${AIDLC_HOOK_ENTRY_PREFIX}${target}`] = hash;
    }
  } else if (!projectProjection && entries && descriptor.distribution === "codex") {
    const rel = `${descriptor.harnessDir}/config.toml`;
    const config = readFileSync(join(sourceRoot, rel), "utf-8");
    // Per-value records drive the refresh; the table and assignment records stay
    // beside them for the whole-table fallback and for older releases.
    const legacy = legacyCodexEntryHashes(config, tomlStatements(config) ?? []);
    entries[rel] = {
      ...Object.fromEntries(Object.entries(legacy).filter(([name]) =>
        CODEX_FRAMEWORK_TABLES.has(name) || CODEX_FRAMEWORK_ASSIGNMENTS.some((assignment) => assignment.name === name)
      )),
      ...Object.fromEntries(codexFrameworkValueEntries(config)),
    };
  }
  const currentHarness = join(projectDir, descriptor.harnessDir);
  const currentHarnessData = join(currentHarness, "tools", "data", "harness.json");
  const currentConfiguration = descriptor.distribution === "claude"
    ? join(currentHarness, "settings.json")
    : descriptor.distribution === "codex"
    ? join(currentHarness, "config.toml")
    : null;
  if (
    !prior &&
    !regularFile(currentHarnessData) &&
    !(currentConfiguration && pathPresent(currentConfiguration)) &&
    modelPolicy === null &&
    projectFlags === null &&
    diagnosticsOverride === undefined
  ) {
    return { root: sourceRoot, regenerated: new Set(), retiredManagedFiles: new Set(), entries, notes };
  }
  const cleanup = mkdtempSync(join(tmpdir(), "aidlc-init-refresh-"));
  try {
  const root = join(cleanup, "projection");
  cpSync(sourceRoot, root, { recursive: true, preserveTimestamps: true });
  // A copy runtime leaves the team's json-entries file out; AI-DLC's part
  // (root-blocks) stands in for it, so a provider answer lands in that part.
  for (const integration of descriptor.rootIntegrations) {
    if (integration.policy !== "json-entries" || pathPresent(join(root, integration.path))) continue;
    const part = rootBlockPath(join(root, descriptor.harnessDir), integration);
    if (regularFile(part)) cpSync(part, join(root, integration.path), { preserveTimestamps: true });
  }
  // A project's own tree holds the team's AGENTS.md or .gitignore
  // with AI-DLC's part merged in, markers and all; the staged release takes
  // AI-DLC's part alone from root-blocks, so a refresh never wraps that part
  // in a second pair of markers.
  for (const integration of descriptor.rootIntegrations) {
    if (integration.policy !== "managed-block") continue;
    const part = rootBlockPath(join(root, descriptor.harnessDir), integration);
    if (regularFile(part)) cpSync(part, join(root, integration.path), { preserveTimestamps: true });
  }
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
  let previousProvider: ProvidersRecord | null = null;
  if (regularFile(currentHarnessData)) {
    const current = JSON.parse(readFileSync(currentHarnessData, "utf-8")) as Record<string, unknown>;
    previousProvider = normalizeProvidersRecord(current.providers);
    const policyKeys = ["models", "flags"].filter((key) => Object.hasOwn(current, key));
    if (policyKeys.length > 0) {
      throw new Error(
        `${currentHarnessData}: harness.json contains legacy policy key(s) ${policyKeys.join(", ")}. ` +
          `Remove ${policyKeys.join(", ")} from ${currentHarnessData}, then run ` +
          `'${configCommand()}' to record policy in aidlc.settings.json.`,
      );
    }
    // A trust acknowledgement covers the row's own allowlist and hook files.
    // Another row ships different ones, so a switch does not carry it. The
    // switch is read from the ownership baseline, whose identity matches the
    // stamp, never from this mutable file.
    const rowChanged = prior !== null && switchesInPlace(prior.distribution, descriptor.distribution);
    for (const [key, value] of Object.entries(current)) {
      if (HARNESS_IDENTITY_KEYS.has(key) || (rowChanged && key === "trust")) continue;
      staged[key] = value;
    }
    if (rowChanged && current.trust !== undefined && prior) {
      notes.push(
        `The trust review recorded for ${prior.distribution} does not carry to ${descriptor.distribution}; once switched, review it again with ` +
          `\`${configInvocationFor(projectDir)} config trust --harness ${descriptor.distribution}${projectTarget(projectDir)}\`.`,
      );
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
  const distribution = staged.distribution;
  if (typeof distribution !== "string") {
    throw new Error(`${stagedHarnessData}: distribution must be a string`);
  }
  const legacyProviderMigration = unrecordedLegacyProviderMigration(
    projectDir,
    descriptor.harnessDir,
    modelHarness(distribution),
    previousProvider,
  );
  const providers = normalizeProvidersRecord(staged.providers);
  if (providers) {
    staged.providers = reconcileProviderActions(
      providers,
      modelHarness(distribution),
      false,
    );
  } else {
    delete staged.providers;
  }
  if (
    regularFile(currentHarnessData) ||
    diagnosticsOverride !== undefined
  ) {
    writeFileSync(stagedHarnessData, `${JSON.stringify(staged, null, 2)}\n`);
    regenerated.add(`${descriptor.harnessDir}/tools/data/harness.json`);
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
    previousProvider,
  );
  // Kiro IDE's steering file carries the project's own memory text, not the
  // release's reference form.
  if (descriptor.distribution === "kiro-ide" && regularFile(join(root, KIRO_IDE_STEERING))) {
    writeFileSync(join(root, KIRO_IDE_STEERING), kiroIdeSteering(projectDir, activeSpace(projectDir)).text);
  }
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
  // Preserve project-owned provider/model fields and unrelated additions.
  // Claude's and Codex's AI-DLC entries are refreshed in place, per entry.
  const retiredManagedFiles = new Set<string>();
  const unproven = new Set<string>();
  const configurationOwnershipClean = preserveUserProviderFields(
    projectDir,
    root,
    descriptor.harnessDir,
    modelHarness(distribution),
    previousProvider,
    normalizeProvidersRecord(staged.providers),
    projectFlags,
    prior,
    notes,
    retiredManagedFiles,
    unproven,
  );
  // A recorded flag overrides a directly customized settings value.
  applyProjectFlagsToProjection(
    root,
    descriptor.harnessDir,
    modelHarness(distribution),
    projectFlags,
  );
  // Preservation starts from project-owned fields, so apply the selected
  // provider once more to prevent the previous provider from being carried
  // back into the final staged projection.
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
    previousProvider,
  );
  if (
    legacyProviderMigration &&
    normalizeProvidersRecord(staged.providers)?.provider !== "amazon-bedrock"
  ) {
    notes.push(
      `Removed legacy AI-DLC Bedrock defaults from ${legacyProviderMigration.path}; ` +
        `${distribution} now uses the provider configured in the harness. To opt back in, run ` +
        `${configCommandForHarness(
          descriptor.harnessDir,
          `providers --provider amazon-bedrock --region ${legacyProviderMigration.region} --yes`,
        )}.`,
    );
  }
  // Provider/model fields can be updated in place only while framework-owned
  // entries still match the recorded baseline.
  if (modelHarness(distribution) === "claude") {
    const rel = `${descriptor.harnessDir}/settings.json`;
    if (configurationOwnershipClean) regenerated.add(rel);
    else regenerated.delete(rel);
  } else if (modelHarness(distribution) === "codex") {
    const rel = `${descriptor.harnessDir}/config.toml`;
    if (configurationOwnershipClean) regenerated.add(rel);
    else regenerated.delete(rel);
  }
  // Kiro CLI: the aws-mcp region is the project's own MCP setting, not a provider
  // answer, so the staged file takes it from the project rather than the release.
  // This runs after the regenerated scan on purpose: a file in `regenerated` is
  // copied without the locally-modified check, and this preservation must not
  // grant that. The staged file equals the project's when the region is its only
  // difference, so the planner preserves it; any other local edit still meets the
  // ownership check and is reported as a conflict instead of being overwritten.
  if (modelHarness(distribution) === "kiro") {
    preserveKiroMcpRegion(projectDir, root, descriptor.harnessDir);
  }

  const currentGrid = join(currentHarness, "tools", "data", "scope-grid.json");
  const stagedGrid = join(stagedHarness, "tools", "data", "scope-grid.json");
  if (regularFile(currentGrid)) {
    cpSync(currentGrid, stagedGrid);
    regenerated.add(`${descriptor.harnessDir}/tools/data/scope-grid.json`);
  }

  const projectOverlays = new Set<string>();
  for (const directory of descriptor.managedDirectories) {
    if (directory !== descriptor.harnessDir && directory !== ".agents") continue;
    const currentDir = join(projectDir, directory);
    if (!pathPresent(currentDir) || !lstatSync(currentDir).isDirectory()) continue;
    for (const nested of regularFilesBelow(currentDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      const staged = join(root, rel);
      if (
        existsSync(staged) ||
        (prior?.shippedOnly && prior.files[rel]) ||
        rel === `${descriptor.harnessDir}/tools/data/aidlc-manifest.json` ||
        !generatedOverlayCandidate(rel, descriptor.harnessDir)
      ) continue;
      mkdirSync(dirname(staged), { recursive: true });
      cpSync(join(projectDir, rel), staged, { preserveTimestamps: true });
      regenerated.add(rel);
      projectOverlays.add(rel);
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
        // Read as AI-DLC wrote it: a CRLF checkout is the same file.
        const current = readFileSync(currentPath, "utf-8").replaceAll("\r\n", "\n");
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
        fresh = mergeConsumes(
          fresh,
          consumeBlocks(
            current,
            new Set((record.consumes ?? []).map((entry) => typeof entry === "string" ? entry : entry.artifact)),
          ),
        );
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
    "AIDLC_COMPOSED_SCOPES_DIR",
    "AIDLC_SENSORS_DIR",
    "AIDLC_AGENTS_DIR",
    "AIDLC_HARNESS_NAME",
  ] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AIDLC_RUNTIME_PROJECT_DIR = root;
    process.env.AIDLC_PROJECT_DIR = root;
    process.env.AIDLC_HARNESS_DIR = descriptor.harnessDir;
    // Copilot and opencode share the .aidlc folder, so the harness is named:
    // the regenerated scope runners then say how to start a new chat in it,
    // as the shipped ones do.
    process.env.AIDLC_HARNESS_NAME = descriptor.distribution;
    process.env.AIDLC_RUNTIME_HARNESS_ROOT = stagedHarness;
    process.env.AIDLC_RULES_DIR = join(root, "aidlc", "spaces", "default", "memory");
    process.env.AIDLC_STAGE_GRAPH = join(stagedHarness, "tools", "data", "stage-graph.json");
    process.env.AIDLC_SCOPE_GRID = stagedGrid;
    process.env.AIDLC_SCOPES_DIR = join(stagedHarness, "scopes");
    // Composed-scope records are the PROJECT's durable data, not part of the
    // staged projection, so point the staged compile at the real ones. Without
    // this the staged compile would fall back to the copied grid alone and could
    // disagree with a later `graph compile` about a composed scope's cells. Paired
    // with the materialize call below, this makes the record the source of record
    // on this path too — reading the records is not sufficient on its own, because
    // the fold-back also needs the identity file present.
    process.env.AIDLC_COMPOSED_SCOPES_DIR = join(projectDir, "aidlc", "scopes");
    process.env.AIDLC_SENSORS_DIR = join(stagedHarness, "sensors");
    process.env.AIDLC_AGENTS_DIR = join(stagedHarness, "agents");
    resetProjectionCaches();
    // Restore any composed scope whose identity file is missing from the staged
    // projection BEFORE compiling, exactly as the `graph compile` CLI does. The
    // fold-back only resurrects a grid column whose identity file exists, so
    // without this a record whose projection is gone — which is precisely the
    // reinstall this recovery exists for — would be filtered out and its column
    // silently dropped into the tree about to be installed. `root` is the staged
    // projection, so the write lands there and never in the live project.
    if (materializeComposedScopeIdentities(root).length > 0) resetProjectionCaches();
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
  if (recordOnly) {
    for (const directory of descriptor.managedDirectories) {
      const stagedDirectory = join(root, directory);
      if (!existsSync(stagedDirectory) || !lstatSync(stagedDirectory).isDirectory()) continue;
      for (const nested of walkFiles(stagedDirectory)) {
        const rel = join(directory, nested).replaceAll("\\", "/");
        const currentPath = join(projectDir, rel);
        if (!regularFile(currentPath) || sha256File(currentPath) !== sha256File(join(root, rel))) {
          regenerated.add(rel);
        }
      }
    }
    if (!configurationOwnershipClean) {
      if (modelHarness(distribution) === "claude") {
        regenerated.delete(`${descriptor.harnessDir}/settings.json`);
      } else if (modelHarness(distribution) === "codex") {
        regenerated.delete(`${descriptor.harnessDir}/config.toml`);
      }
    }
  }
  return { root, cleanup, regenerated, retiredManagedFiles, projectOverlays, unproven, entries, notes };
  } catch (error) {
    rmSync(cleanup, { recursive: true, force: true });
    throw error;
  }
}

// An earlier release put a generic template (node_modules, dist, editor
// files) in AI-DLC's part of .gitignore; a refresh keeps those lines as the
// project's own and says so once.
const KEPT_GITIGNORE_LINES_DETAIL = "kept your own ignore lines";
const KEPT_GITIGNORE_LINES_NOTE =
  "Kept your .gitignore entries for node_modules, dist and editor files; AI-DLC now adds only its own lines.";

function unchangedManagedBlockHash(
  projectDir: string,
  sourceRoot: string,
  harnessDir: string,
  integration: ProjectionDescriptor["rootIntegrations"][number],
): string | undefined {
  const targetPath = join(projectDir, integration.path);
  const merged = mergeBlock(
    integration.path,
    regularFile(targetPath) ? readFileSync(targetPath, "utf-8") : "",
    readFileSync(shippedRootIntegrationPath(sourceRoot, harnessDir, integration), "utf-8"),
    integration.marker || basename(integration.path),
    integration.legacySignatures?.wholeFileHashes,
  );
  return !merged.error && merged.currentHash && merged.currentHash === merged.nextHash
    ? merged.currentHash
    : undefined;
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

function holdsProjection(root: string): boolean {
  return readdirSync(root).some((name) =>
    existsSync(join(root, name, "tools", "data", "aidlc-stamp.json"))
  );
}

// A source is one harness projection, or the copy channel's release layout:
// aidlc-copy-runtime-X.Y.Z.tar.gz, or its extracted folder, holds one
// projection per harness under runtime/, and the harness picks the one to use.
function materializeSource(
  path: string,
  distribution?: string,
): { root: string; cleanup?: string; note?: string; holds?: string[] } {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) throw new Error(`init source does not exist: ${absolute}`);
  let root = absolute;
  let cleanup: string | undefined;
  let note: string | undefined;
  if (!statSync(absolute).isDirectory()) {
    const sidecar = `${absolute}.sha256`;
    if (!regularFile(sidecar)) {
      note = `Used ${basename(absolute)} without a .sha256 beside it, so its checksum was not checked.`;
    } else {
      const expected = readFileSync(sidecar, "utf-8").trim().split(/\s+/)[0];
      if (expected !== sha256File(absolute).replace(/^sha256:/, "")) {
        throw new Error(`${basename(absolute)} does not match ${basename(sidecar)}; nothing was changed`);
      }
    }
    cleanup = mkdtempSync(join(tmpdir(), "aidlc-init-source-"));
    extractTarGz(absolute, cleanup);
    root = cleanup;
  }
  try {
    const runtimes = holdsProjection(root)
      ? null
      : existsSync(join(root, "runtime")) && statSync(join(root, "runtime")).isDirectory()
      ? join(root, "runtime")
      : basename(root) === "runtime"
      ? root
      : null;
    if (runtimes) {
      const available = readdirSync(runtimes)
        .filter((name) => holdsProjection(join(runtimes, name)))
        .sort();
      const pick = distribution ?? (available.length === 1 ? available[0] : undefined);
      if (!pick) {
        throw new Error(`${path} holds the ${available.join(", ")} harnesses; pass --harness <name>`);
      }
      if (!available.includes(pick)) {
        throw new Error(`${path} does not include the ${pick} harness; it has ${available.join(", ")}`);
      }
      root = join(runtimes, pick);
      return { root, cleanup, note, holds: available };
    }
    return { root, cleanup, note };
  } catch (error) {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
    throw error;
  }
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
  // Something the user should know about where these bytes came from.
  note?: string;
  stamp: ReturnType<typeof projectionFiles>["stamp"];
  descriptor: ReturnType<typeof projectionFiles>["descriptor"];
  projectProjection?: boolean;
  // The harnesses the files passed to --from hold beside this one.
  holds?: readonly string[];
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

// No available source carries the harness this command needs: nothing is
// installed for it, or a project pin rules out the one there is. main() turns
// it into the channel's remedy (`--from` naming that harness and release on
// the copy channel, `--pin` on a native install), so both travel with the
// error instead of being guessed from its text.
class MissingInstalledSource extends Error {
  constructor(
    message: string,
    readonly distribution: string,
    readonly requiredVersion?: string,
  ) {
    super(message);
  }
}

// A release this command needs and this machine does not have, and why. The
// error, the download prompt, and the offline route are all rendered from it.
type ReleaseNeed = {
  version: string;
  distribution: string;
  // The project's directory for this harness, when it already has one.
  harnessDir?: string;
  // The release those files are, when a pin asks for another.
  current?: string;
  cause: "pin" | "pin-missing" | "add" | "switch" | "restore" | "refresh" | "mcp" | "from";
  // For "switch": the installed row the run replaces in the same directory.
  switchingFrom?: string;
  // For "mcp": the project has no .mcp.json at all, rather than an emptied one.
  absent?: boolean;
};

// Whether a copied project's own files can apply its project choices. Plugins
// and completions always can. MCP defaults can only while .mcp.json still
// holds every server the release shipped: those are known by the descriptor's
// hashes alone, so a server the project dropped cannot come back from here.
function ownFilesCoverChoices(
  projectDir: string,
  descriptor: ProjectionDescriptor,
  mcpMode: "defaults" | "none" | undefined,
): boolean {
  if (mcpMode !== "defaults") return true;
  const integration = descriptor.rootIntegrations.find((item) =>
    item.policy === "json-map" && item.optional
  );
  const shipped = integration?.legacySignatures?.jsonEntryHashes;
  if (!integration?.jsonKey || !shipped) return true;
  // A copy carries the shipped list itself, whether or not the team has the file.
  if (regularFile(rootBlockPath(join(projectDir, descriptor.harnessDir), integration))) return true;
  let servers: unknown;
  try {
    servers = (readJsonFile(join(projectDir, integration.path)) as Record<string, unknown>)[
      integration.jsonKey
    ];
  } catch {
    return false;
  }
  if (!isRecord(servers)) return false;
  const current = servers;
  return Object.entries(shipped).every(([entry, hashes]) =>
    entry in current && hashes.includes(sha256Bytes(canonical(current[entry])))
  );
}

class NeedsRelease extends Error {
  constructor(readonly need: ReleaseNeed) {
    super(releaseNeedSentence(need));
  }
}

// What is wrong, in one sentence the user recognizes.
function releaseNeedSentence(need: ReleaseNeed): string {
  const dir = need.harnessDir ?? need.distribution;
  switch (need.cause) {
    case "pin":
      return `This project is pinned to ${need.version}, but ${dir} has ${need.current} files.`;
    case "pin-missing":
      return `This project is pinned to ${need.version}, which is not installed.`;
    case "add":
      return `Adding ${need.distribution} needs the ${need.version} release files.`;
    case "switch":
      return `Switching ${dir} from ${need.switchingFrom} to ${need.distribution} needs the ${need.version} release files.`;
    case "restore":
      return `${dir} is missing aidlc/spaces/default/memory/.`;
    case "refresh":
      return `Refreshing ${dir} needs the ${need.version} release files.`;
    case "mcp":
      return need.absent
        ? `${dir} has no MCP server list for ${need.version}.`
        : `${dir} no longer has the MCP server list for ${need.version}.`;
    case "from":
      return `The files passed to --from are ${need.current}, but this project is pinned to ${need.version}.`;
  }
}

// The download half of a question: what is fetched from where, and what then
// happens to the project. "ask" is the prompt ("Download ... and update
// .claude?"); "state" is the sentence a section's own question gains.
function releaseNeedDownload(need: ReleaseNeed, host: string, form: "ask" | "state"): string {
  const [download, add, restore, update, switchTo] = form === "ask"
    ? ["Download", "add", "restore", "update", "switch"]
    : ["This first downloads", "adds", "restores", "updates", "switches"];
  const fetch = `${download} ${need.version} from ${host}`;
  switch (need.cause) {
    case "pin-missing":
      return form === "ask"
        ? `Download and install ${need.version} from ${host}`
        : `This first downloads and installs ${need.version} from ${host}`;
    case "add":
      return `${fetch} and ${add} ${need.distribution}`;
    case "switch":
      return `${fetch} and ${switchTo} ${need.harnessDir} to ${need.distribution}`;
    case "restore":
    case "mcp":
      return `${fetch} and ${restore} it`;
    default:
      return `${fetch} and ${update} ${need.harnessDir ?? need.distribution}`;
  }
}

function selectSource(
  requested: string | undefined,
  from: string | undefined,
  existingDistribution: string | undefined,
  requiredVersion?: string,
): ConfigSource {
  if (from) {
    const source = materializeSource(from, requested ?? existingDistribution);
    const { stamp, descriptor } = projectionFiles(source.root);
    if (requested && stamp.distribution !== requested) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`source is ${stamp.distribution}, not requested harness ${requested}`);
    }
    if (existingDistribution && stamp.distribution !== existingDistribution) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      // A source alone never replaces the installed harness; naming the
      // harness is the request to switch.
      if (switchesInPlace(existingDistribution, stamp.distribution)) {
        throw new SwitchRefusal(
          `existing project uses ${existingDistribution}; refusing ${stamp.distribution} without --harness ${stamp.distribution}, which switches ${stamp.harnessDir} to it in place`,
          { kind: "switch", harness: stamp.distribution },
        );
      }
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
    throw new MissingInstalledSource(
      requiredVersion && versionFiltered.length === 0
        ? `project requires ${requiredVersion}, which is not installed; run aidlc config --pin ${requiredVersion}`
        : requiredVersion
        ? `harness ${selectedName} is not installed in ${requiredVersion}; run aidlc config --pin ${requiredVersion}`
        : `harness ${selectedName} is not installed`,
      selectedName,
      requiredVersion,
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

// A link (or other special file) among a copied project's own files stops
// config, since a rule read through one would be left out of the plan. The
// failure names the project path, so the person can put the file itself there.
class ProjectLinkError extends Error {
  constructor(readonly path: string, link: boolean) {
    super(`${shownValue(path)} is ${link ? "a link" : "not a regular file"}`);
  }
}

function assertNoProjectLinks(projectDir: string, directory: string): void {
  const visit = (rel: string): void => {
    for (const entry of readdirSync(join(projectDir, rel)).sort()) {
      const child = `${rel}/${entry}`;
      if (hostToolPath(child)) continue;
      const stat = lstatSync(join(projectDir, child));
      if (stat.isDirectory()) visit(child);
      else if (!stat.isFile()) throw new ProjectLinkError(child, stat.isSymbolicLink());
    }
  };
  visit(directory);
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
  descriptor.rootIntegrations = readRootIntegrations(descriptor.rootIntegrations) as ProjectionDescriptor["rootIntegrations"];
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
  for (const directory of descriptor.managedDirectories) {
    assertProjectionPathHasNoSymlinks(projectDir, directory);
    const source = join(projectDir, directory);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) {
      throw new Error(`copied projection is missing managed directory ${directory}`);
    }
    assertNoProjectLinks(projectDir, directory);
  }
  const cleanup = mkdtempSync(join(tmpdir(), "aidlc-config-copy-source-"));
  try {
  const root = join(cleanup, "projection");
  mkdirSync(root, { recursive: true });
  for (const directory of descriptor.managedDirectories) {
    const source = join(projectDir, directory);
    // What a host tool installed for itself (links in its node_modules
    // included) is never release content, so it stays where it is and out of
    // the source. Any other link was refused above.
    cpSync(source, join(root, directory), {
      recursive: true,
      preserveTimestamps: true,
      filter: (path) => !hostToolPath(relative(projectDir, path).replaceAll("\\", "/")),
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
  } catch (error) {
    rmSync(cleanup, { recursive: true, force: true });
    throw error;
  }
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
  // Kiro owns model access; all other harnesses default to preserving the
  // provider already configured by the user.
  provider: "current" | "amazon-bedrock" | "harness-managed";
  region: string;
  profile: string;
  preset: "balanced" | "thorough" | "minimal" | "unchanged";
  plugins: string;
  pluginLabel: string;
  mcp: "defaults" | "none";
  target: SettingsTarget;
  providerVerified: boolean;
  opencodeDefault: boolean;
  // Kiro CLI only: the person's session model, read from their personal Kiro
  // settings. null means Kiro could not be read, so the session is left alone.
  kiro?: FirstRunKiroSession | null;
};

type FirstRunKiroSession = {
  cli: string;
  session: Extract<KiroPersonalSession, { ok: true }>;
  // The model chosen to save; undefined keeps the current one.
  setModel?: KiroModel;
  // The account's models, fetched once when first needed.
  models?: KiroModelList;
};

// A question config asked got no answer: the person cancelled it, or the
// input closed (EOF) so no answer can come.
class FirstRunCancelled extends Error {
  constructor(readonly inputClosed = false) {
    super(inputClosed ? "the input closed before the question was answered" : "the question was cancelled");
  }
}

function firstRunPromptValue(value: string | null): string {
  if (value === null) throw new FirstRunCancelled(true);
  const normalized = value.trim();
  if (normalized.includes("\u0003")) throw new FirstRunCancelled();
  return normalized;
}

// What the person reads when a question got no answer: that config stopped
// (the first-run wizard writes nothing before its last answer, so it says
// nothing was written; elsewhere part of the work may already be done), and,
// when no answer could come, the command to run again where they can answer.
function noAnswerLines(error: FirstRunCancelled, rerun: string, nothingWritten = false): string {
  const stopped = nothingWritten ? "Nothing written" : "Stopped";
  if (!error.inputClosed) return `\n  ${stopped}.\n`;
  return `\n  ${stopped}: this needs an answer, and the input is closed. Run ${rerun} again where you can answer.\n`;
}

// First-run rows are a lead (the number and label, or the spaces under them)
// and its text. On a terminal that reports its width, text that does not fit
// wraps between words and continues under its own column, so a narrow panel
// such as an editor's terminal does not break a phrase back to the left edge.
// Rows that fit keep their authored line breaks, and output that is not a
// terminal is never wrapped. One column stays free so a full line never meets
// the terminal's own wrap. Widths count the columns the terminal shows: a color
// code takes none and an East Asian wide character takes two. A row that
// starts at the left edge continues two columns in. A quoted span (backticks,
// or single or double quotes that open a word) is one word, so a command or a
// name the person types is never split across lines. AIDLC_TEST_CONFIG_COLUMNS
// is the test-only stand-in for the terminal width.
const MENU_TEXT_MIN_COLUMNS = 20;
const MENU_WORD = /(\s*)(`[^`]*`\S*|'[^'\s][^']*'\S*|"[^"\s][^"]*"\S*|\S+)/g;

function menuWidth(): number {
  const seam = Number(process.env.AIDLC_TEST_CONFIG_COLUMNS);
  if (seam > 0) return seam;
  const columns = process.stdout.isTTY ? process.stdout.columns ?? 0 : 0;
  return columns > 0 ? columns : Number.POSITIVE_INFINITY;
}

function visibleColumns(text: string): number {
  return Bun.stringWidth(text);
}

function menuRowLines(
  lead: string,
  parts: readonly string[],
  width: number,
): string[] {
  const leadColumns = visibleColumns(lead);
  const indent = " ".repeat(leadColumns || 2);
  const firstRoom = Math.max(width - 1 - leadColumns, MENU_TEXT_MIN_COLUMNS);
  const restRoom = Math.max(width - 1 - indent.length, MENU_TEXT_MIN_COLUMNS);
  const place = (text: string, index: number) => `${index === 0 ? lead : indent}${text}`;
  if (
    parts.every((part, index) => visibleColumns(part) <= (index === 0 ? firstRoom : restRoom))
  ) {
    return parts.map(place);
  }
  const lines: string[] = [];
  let line = "";
  for (const [, gap, word] of parts.join(" ").matchAll(MENU_WORD)) {
    const room = lines.length === 0 ? firstRoom : restRoom;
    if (line && visibleColumns(line) + gap.length + visibleColumns(word) > room) {
      lines.push(line);
      line = word;
    } else {
      line += line ? gap + word : word;
    }
  }
  lines.push(line);
  return lines.map(place);
}

function writeMenuRow(lead: string, ...parts: string[]): void {
  for (const line of menuRowLines(lead, parts, menuWidth())) {
    process.stdout.write(`${line}\n`);
  }
}

// A command the person runs or pastes stays one physical line: after its label
// when it fits, else whole on its own line at the row's margin, where a
// terminal too narrow for it soft-wraps it and it still copies as one line.
function commandRowLines(lead: string, command: string, width: number): string[] {
  const label = lead.trimEnd();
  if (!label.trim() || visibleColumns(lead) + visibleColumns(command) <= width - 1) {
    return [`${lead}${command}`];
  }
  const margin = /^\s*/.exec(lead)?.[0] ?? "";
  return [label, `${margin || "  "}${command}`];
}

function writeCommandRow(lead: string, command: string): void {
  for (const line of commandRowLines(lead, command, menuWidth())) {
    process.stdout.write(`${line}\n`);
  }
}

// Authored lines under one indent, each laid out as a row: a numbered step
// ("1. ") takes the lines indented under its text as its own continuation,
// columns split at the last two-space gap so the final column (a command's
// description, a summary's detail) wraps under itself, and an empty string is
// a blank line.
function menuLines(indent: string, lines: readonly string[], width: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) {
      out.push("");
      continue;
    }
    const margin = /^\s*/.exec(line)?.[0] ?? "";
    const marker = /^\d+\.\s+/.exec(line.slice(margin.length))?.[0] ?? "";
    const under = `${margin}${" ".repeat(marker.length)}`;
    const parts = [line.slice(margin.length + marker.length)];
    while (marker) {
      const next = lines[index + 1] ?? "";
      if (!next.startsWith(under) || !/^\S/.test(next.slice(under.length))) break;
      parts.push(next.slice(under.length));
      index++;
    }
    const column = parts.length === 1
      ? /^\S(?:.*\S)? {2,}(?=\S)/.exec(parts[0])?.[0] ?? ""
      : "";
    out.push(...menuRowLines(
      `${indent}${margin}${marker}${column}`,
      [parts[0].slice(column.length), ...parts.slice(1)],
      width,
    ));
  }
  return out;
}

function writeMenuLines(indent: string, lines: readonly string[]): void {
  for (const line of menuLines(indent, lines, menuWidth())) {
    process.stdout.write(`${line}\n`);
  }
}

// A multi-line message laid out for the terminal, line by line; unchanged when
// the width is unknown.
function menuText(text: string): string {
  const width = menuWidth();
  return width === Number.POSITIVE_INFINITY
    ? text
    : menuLines("", text.split("\n"), width).join("\n");
}

function writeMenuText(text: string): void {
  process.stdout.write(menuText(text));
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

// A harness whose editor has no CLI to probe names that editor
// (descriptor.editorTerminalApp), and the editor's integrated terminal is the
// signal that setup is for it: TERM_PROGRAM is exactly the editor's name, or
// the git askpass helper VS Code-based editors set (VSCODE_GIT_ASKPASS_NODE)
// is the editor's executable. A miss only loses the default choice.
export function launchedFromEditorTerminal(
  app: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const name = app.toLowerCase();
  if ((env.TERM_PROGRAM ?? "").toLowerCase() === name) return true;
  const helper = (env.VSCODE_GIT_ASKPASS_NODE ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return helper === name || helper === `${name}.exe`;
}

function launchedFromCandidateEditor(candidate: InstalledSourceCandidate): boolean {
  const app = candidate.descriptor.editorTerminalApp;
  return app !== undefined && launchedFromEditorTerminal(app);
}

function detectedCandidateChoices(
  candidates: readonly InstalledSourceCandidate[],
  detection: FirstRunDetection,
): InstalledSourceCandidate[] {
  const detected = candidates.filter((candidate) =>
    detection.harnesses[candidate.stamp.distribution]?.found
  );
  // In the terminal of a harness's own editor, that harness leads: it is
  // chosen outright when no other harness CLI is found, and is the default
  // when one is.
  const editor = candidates.find(launchedFromCandidateEditor);
  return editor
    ? [editor, ...detected.filter((candidate) => candidate !== editor)]
    : detected;
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
  // Setup writes the person's Kiro session itself, after every child: those
  // settings are outside the rollback snapshot.
  env.AIDLC_CONFIG_DEFER_KIRO_SESSION = "1";
  const commandArgs = isCompiledExecutable()
    ? ["config", ...args]
    : [fileURLToPath(import.meta.url), "config", ...args];
  const result = spawnSync(process.execPath, commandArgs, {
    cwd,
    env,
    encoding: "utf-8",
    input: "",
    timeout: LONG_SUBPROCESS_TIMEOUT_MS,
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

// Each setup step runs as a `config --json` child, so a failed step reports a
// JSON result envelope. Setup shows its message as a sentence and its fix as a
// command. The children's `--from` is setup's own, so a fix that names it
// becomes rerunning setup.
export function firstRunFailureLines(raw: string, rerun: string): string[] {
  let message = raw.trim();
  let remediation: string | undefined;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (typeof parsed.message === "string") message = parsed.message;
    else if (typeof parsed.error === "string") message = parsed.error;
    if (typeof parsed.remediation === "string") remediation = parsed.remediation;
  } catch {
    // Not an envelope: the message is already plain text.
  }
  if (/source changed (?:after planning|while staging)/.test(message)) {
    return [
      "Setup stopped: another AIDLC process was writing at the same time.",
      `fix: run \`${rerun}\` again`,
    ];
  }
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  const fix = remediation && !remediation.includes("--from <valid-release-data>")
    ? remediation
    : remediation
    ? `run \`${rerun}\` again`
    : undefined;
  return [`Setup stopped: ${sentence}`, ...(fix ? [`fix: ${fix}`] : [])];
}

// "Setup stopped" wraps as prose; a fix wraps under its own text, except a fix
// that is itself a command, which stays whole.
function writeFirstRunFailureLines(lines: readonly string[]): void {
  for (const line of lines) {
    const fix = /^fix: (.*)$/.exec(line)?.[1];
    if (fix === undefined) writeMenuRow("  ", line);
    else if (/^(?:aidlc|bun) \S/.test(fix)) writeCommandRow("  fix: ", fix);
    else writeMenuRow("  fix: ", fix);
  }
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
    return ["kiro                          open Kiro IDE (or kiro-cli) in this repo", '/aidlc "what you want built"  describe your first intent'];
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
  if (choices.preset !== "unchanged") {
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
  }
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
  // Harness-managed access has no provider answer to write.
  if (choices.provider === "harness-managed") return;
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
  }
  providerArgs.push("--yes", "--json");
  runConfigChild(providerArgs, projectDir, snapshot);
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

async function applyFirstRunKiroSession(choices: FirstRunChoices): Promise<KiroSessionResult | null> {
  const kiro = choices.kiro;
  if (!kiro || choices.candidate.stamp.distribution !== "kiro") return null;
  const result = await applyKiroSessionPlan({
    cli: kiro.cli,
    session: kiro.session,
    ...(kiro.setModel ? { setModel: kiro.setModel.id } : {}),
    preset: choices.preset === "unchanged" ? null : choices.preset,
    fetchLevels: true,
    modelsCommand: configCommand("models"),
    doctorCommand: `${aidlcInvocation()} doctor`,
  });
  return result;
}

function renderFirstRunEnding(
  projectDir: string,
  choices: FirstRunChoices,
  kiro: KiroSessionResult | null = null,
): void {
  // A write Kiro refused is listed with the other things that need the person;
  // any line before it (a level fallback, say) still prints with the receipts.
  const kiroFailed = kiro !== null && !kiro.ok;
  const kiroLines = kiro ? (kiroFailed ? kiro.lines.slice(0, -1) : kiro.lines) : [];
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
  // A receipt's detail continues under its opening parenthesis.
  process.stdout.write("\n");
  writeMenuRow(
    `  Writing project files ... ${successText("done", process.stdout)}  `,
    `(${choices.candidate.descriptor.harnessDir}/ and aidlc/, ${count} files)`,
  );
  const harness = modelHarness(choices.candidate.stamp.distribution);
  if (choices.preset === "unchanged" && sessionSetsAgentModels(harness)) {
    writeMenuRow("  Model preset ... not needed  ", `(${sessionModelsDetail(harness, null)})`);
  } else if (choices.preset === "unchanged") {
    process.stdout.write("  Model preset ... left unchanged\n");
  } else {
    writeMenuRow(
      `  Recording model preset ... ${successText("done", process.stdout)}  `,
      `(${
        choices.target === "project"
          ? "aidlc.settings.json in this project"
          : choices.target === "local"
          ? "aidlc.settings.local.json in this project"
          : settingsPathForTarget(projectDir, choices.target)
      })`,
    );
  }
  if (kiroLines.length > 0) {
    process.stdout.write("\n");
    for (const line of kiroLines) {
      if (/^\s/.test(line)) process.stdout.write(`  ${line}\n`);
      else writeMenuRow("  ", line);
    }
    process.stdout.write("\n");
  }
  const remaining = [
    ...postApplyOutstandingActions(
      projectDir,
      choices.candidate.descriptor.harnessDir,
      modelHarness(choices.candidate.stamp.distribution),
    ),
    ...(kiro && kiroFailed
      ? [{
          section: "models" as const,
          id: "kiro-session-unsaved",
          message: (kiro.lines.at(-1) ?? "Kiro did not save your session model.").replace(/ Run `[^`]+` to try again\.$/, ""),
          command: configCommand("models"),
        }]
      : []),
  ];
  if (remaining.length > 0) {
    process.stdout.write(
      `${kiroLines.length > 0 ? "" : "\n"}  ${
        remaining.length === 1 ? "One thing needs you" : `${remaining.length} things need you`
      } - ${
        remaining.length === 1 ? "it can't" : "they can't"
      } be done automatically:\n\n`,
    );
    for (const action of remaining) {
      if (action.id === "runtime-aidlc-missing") {
        writeMenuRow(
          "    ",
          "Hooks run outside your interactive shell PATH, and aidlc is not available there.",
        );
        // An instruction wraps; the line indented under it is the command to
        // paste and stays whole.
        for (const line of firstRunPathRemediation(process.platform, binRoot())) {
          if (/^\s/.test(line)) writeCommandRow("    ", line);
          else writeMenuRow("    ", line);
        }
        process.stdout.write("\n");
        writeCommandRow(
          "    Full diagnostics: ",
          configCommandForHarness(
            choices.candidate.descriptor.harnessDir,
            "runtime --show",
          ),
        );
        process.stdout.write("\n");
        continue;
      }
      writeMenuRow("    ", action.message);
      if (action.step) writeMenuRow("    fix: ", action.step);
      else writeCommandRow("    fix: ", action.command);
      process.stdout.write("\n");
    }
  }
  // The first run applies through a child whose notes are not shown, so the
  // record-hiding finding is read here, where the person looks.
  for (const warning of committedRecordIgnoreConflicts(projectDir)) {
    writeMenuRow("  Note: ", `${warning}.`);
    process.stdout.write("\n");
  }
  const steps = choices.candidate.descriptor.firstRunSteps ??
    firstRunNextCommands(choices.candidate.stamp.distribution);
  process.stdout.write("  Setup complete. Start your first workflow:\n\n");
  writeMenuLines("    ", steps);
}

// Re-derive the provider choice whenever the harness changes. Harness-managed
// access has no answer to record; every other harness is Bedrock-oriented.
// A Bedrock-oriented answer (`amazon-bedrock` or `unchanged`) carries across
// Bedrock-oriented harnesses unchanged.
// --- Kiro CLI session model -------------------------------------------------
//
// Kiro CLI runs each AI-DLC session on one model, saved in the person's personal
// Kiro settings (see aidlc-kiro-session.ts). These prompts are shared by first-run
// setup and `config models`; nothing here writes.

function kiroSessionFor(distribution: string): FirstRunKiroSession | null {
  if (distribution !== "kiro") return null;
  const cli = kiroCliPath();
  if (!cli) return null;
  const session = readKiroPersonalSession(cli);
  return session.ok ? { cli, session } : null;
}

// A saved model the account no longer offers fails every prompt, so setup asks
// for another instead of keeping it. Unknown when the list cannot be fetched.
function kiroModelRetired(kiro: FirstRunKiroSession): boolean {
  const current = kiro.session.model;
  if (!current) return false;
  kiro.models ??= listKiroModels(kiro.cli);
  return kiro.models.ok && !kiro.models.models.some((model) => model.id === current);
}

function kiroRetiredIntro(model: string): string {
  return `Your Kiro model ${model} is not offered on your Kiro account any more, so every prompt would fail. Choose the session model (Enter takes the recommended one):`;
}

function firstRunKiroSummary(kiro: FirstRunKiroSession | null | undefined): string {
  if (!kiro) return "unchanged (Kiro settings not read)";
  if (kiro.setModel) {
    const rate = kiroRateLabel(kiro.setModel.rate);
    return `${kiro.setModel.id}${rate ? ` (${rate})` : ""}, in your personal Kiro settings`;
  }
  return `${kiro.session.model ?? "Kiro auto"} (kept)`;
}

// Lists the account's models and asks for one, in Kiro's order with each
// model's credit multiplier. Returns undefined to keep the current model.
function chooseKiroSessionModel(
  kiro: FirstRunKiroSession,
  preset: KiroPreset | null,
  intro?: string,
): KiroModel | undefined {
  kiro.models ??= listKiroModels(kiro.cli);
  const list = kiro.models;
  const current = kiro.session.model;
  if (!list.ok) {
    writeMenuRow(
      "  ",
      `Could not fetch your Kiro models (offline or Kiro did not answer), so ${
        current ?? "Kiro auto"
      } stays for now.${current ? "" : ` ${kiroAutoRecommendation(preset)}`} Run \`${
        configCommand("models")
      }\` later to choose one.`,
    );
    process.stdout.write("\n");
    return undefined;
  }
  if (intro) writeMenuRow("  ", intro);
  const models = list.models;
  // Enter never keeps a model the account no longer offers: with only preview
  // or internal models left, the first one offered is recommended.
  const retired = current !== null && !models.some((model) => model.id === current);
  const recommended = recommendedKiroModel(models, current) ?? (retired ? models[0]?.id ?? null : null);
  const keepLabel = current ? `keep ${current}` : "keep Kiro auto";
  const idWidth = Math.max(keepLabel.length, ...models.map((model) => model.id.length)) + 2;
  const numberWidth = String(models.length + 1).length;
  const number = (index: number) => `${String(index).padStart(numberWidth)}.`;
  models.forEach((model, index) => {
    const tag = model.tag ?? "";
    process.stdout.write(
      `    ${number(index + 1)} ${model.id.padEnd(idWidth)}${kiroRateLabel(model.rate).padEnd(7)}${
        tag.padEnd(9)
      }${model.id === recommended ? "(recommended)" : ""}`.trimEnd() + "\n",
    );
  });
  process.stdout.write(
    `    ${number(models.length + 1)} ${keepLabel.padEnd(idWidth)}${
      !current
        ? "Kiro keeps picking the model; no effort preset"
        : retired
        ? "not offered on your Kiro account any more"
        : "your current model"
    }\n`,
  );
  writeMenuRow(
    "  ",
    "Multiplier = Kiro credits relative to Kiro auto. AI-DLC sessions are long, so it adds up.",
  );
  const recommendedIndex = recommended
    ? models.findIndex((model) => model.id === recommended) + 1
    : models.length + 1;
  const selected = promptChoice("  Model", models.length + 1, recommendedIndex);
  if (selected === models.length + 1) {
    process.stdout.write(`  Keeping ${current ?? "Kiro auto"}.\n\n`);
    return undefined;
  }
  const model = models[selected - 1];
  if (model.id === current) {
    process.stdout.write(`  Keeping ${current}.\n\n`);
    return undefined;
  }
  process.stdout.write(`  Using ${model.id}${model.rate === null ? "" : ` (${kiroRateLabel(model.rate)})`}.\n\n`);
  return model;
}

// The session-model question: keep or choose. Kiro auto recommends choosing.
function askKiroSessionModel(kiro: FirstRunKiroSession, preset: KiroPreset | null): void {
  const current = kiro.session.model;
  if (current && kiroModelRetired(kiro)) {
    kiro.setModel = chooseKiroSessionModel(kiro, preset, kiroRetiredIntro(current));
    return;
  }
  if (current) {
    writeMenuRow(
      "  ",
      `Kiro CLI runs each AI-DLC session on one model. You're on ${current}, from your personal Kiro settings.`,
    );
    writeMenuRow(`    1. keep ${current}   `, "(recommended, default)");
    writeMenuRow("    2. choose another model   ", "list the models your Kiro account offers");
    if (promptChoice("  Session model", 2, kiro.setModel ? 2 : 1) === 1) {
      kiro.setModel = undefined;
      process.stdout.write(`  Keeping ${current}.\n\n`);
      return;
    }
  } else {
    writeMenuRow(
      "  ",
      `Kiro CLI runs each AI-DLC session on one model. You're on ${KIRO_AUTO_DEFINITION}. ${
        kiroAutoRecommendation(null)
      }`,
    );
    writeMenuRow(
      "    1. choose a model   ",
      "list the models your Kiro account offers  (recommended, default)",
    );
    writeMenuRow(
      "    2. keep Kiro auto   ",
      "Kiro keeps picking the model; the effort preset stays unset",
    );
    if (promptChoice("  Session model", 2, 1) === 2) {
      kiro.setModel = undefined;
      process.stdout.write("  Keeping Kiro auto.\n\n");
      return;
    }
  }
  kiro.setModel = chooseKiroSessionModel(kiro, preset);
}

// The preset step's wording on Kiro CLI: one effort for the whole session.
// Setup runs on a project with no preset yet; `config models` keeps the
// recorded one (removing it is `--reset`).
function writeKiroPresetRows(model: string | null, context: "setup" | "models" = "setup"): void {
  writeMenuRow(
    "  ",
    model
      ? `On Kiro CLI the preset sets one effort for the whole session on ${model}.`
      : "On Kiro CLI the preset sets one effort for the whole session. Under Kiro auto it applies once you choose a model.",
  );
  writeMenuRow("    1. balanced    ", `${KIRO_EFFORT_LABEL[KIRO_PRESET_EFFORT.balanced]} effort  (recommended, default)`);
  writeMenuRow("    2. thorough    ", `${KIRO_EFFORT_LABEL[KIRO_PRESET_EFFORT.thorough]} effort: deeper and slower, costs more`);
  writeMenuRow("    3. minimal     ", `${KIRO_EFFORT_LABEL[KIRO_PRESET_EFFORT.minimal]} effort: fastest and cheapest`);
  writeMenuRow(
    "    4. unchanged   ",
    context === "setup"
      ? "records no preset; the model keeps Kiro's own effort"
      : "keeps the recorded preset as it is",
  );
}

// A preset changes nothing where agents always run on the session's model and
// effort, so setup records none there unless the person picks one.
function firstRunDefaultPreset(distribution: string): FirstRunChoices["preset"] {
  return sessionSetsAgentModels(modelHarness(distribution)) ? "unchanged" : "balanced";
}

function providerForHarness(
  current: FirstRunChoices["provider"],
  distribution: string,
): FirstRunChoices["provider"] {
  if (harnessOwnsModelAccess(modelHarness(distribution))) return "harness-managed";
  return current === "harness-managed" ? "current" : current;
}

function customizeFirstRun(
  initial: InstalledSourceCandidate,
  candidates: readonly InstalledSourceCandidate[],
  detection: FirstRunDetection,
): FirstRunChoices | null {
  const aws = awsSummary(detection.aws);
  const choices: FirstRunChoices = {
    candidate: initial,
    provider: providerForHarness("current", initial.stamp.distribution),
    region: aws.region,
    profile: "",
    preset: firstRunDefaultPreset(initial.stamp.distribution),
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
      writeMenuRow(
        "  Detected on this machine: ",
        `${
          detected.length > 0
            ? detected.map((item) => item.descriptor.productName).join(", ")
            : "none"
        }.`,
      );
      process.stdout.write("\n");
      const previousDistribution = choices.candidate.stamp.distribution;
      choices.candidate = chooseHarness(
        candidates,
        detection,
        choices.candidate.stamp.distribution,
      );
      if (choices.candidate.stamp.distribution !== previousDistribution) {
        choices.kiro = undefined;
        // The default preset follows the harness; a preset the person chose stays.
        if (choices.preset === firstRunDefaultPreset(previousDistribution)) {
          choices.preset = firstRunDefaultPreset(choices.candidate.stamp.distribution);
        }
      }
      choices.mcp = choices.candidate.stamp.distribution === "claude"
        ? "defaults"
        : "none";
      choices.provider = providerForHarness(
        choices.provider,
        choices.candidate.stamp.distribution,
      );
      return;
    }
    if (step === 2) {
      const distribution = choices.candidate.stamp.distribution;
      if (distribution === "kiro") {
        process.stdout.write("  Step 2 of 6 - Session model\n");
        choices.provider = "harness-managed";
        if (choices.kiro === undefined) choices.kiro = kiroSessionFor(distribution);
        if (!choices.kiro) {
          writeMenuRow(
            "  ",
            `Could not read your Kiro settings, so the session model stays as it is. Run \`${
              configCommand("models")
            }\` later to choose one.`,
          );
          process.stdout.write("\n");
          return;
        }
        askKiroSessionModel(choices.kiro, isKiroPreset(choices.preset) ? choices.preset : null);
        return;
      }
      process.stdout.write("  Step 2 of 6 - Model provider\n");
      const product = choices.candidate.descriptor.productName;
      const harness = modelHarness(choices.candidate.stamp.distribution);
      if (harnessOwnsModelAccess(harness)) {
        writeMenuRow(
          "  ",
          `${ownedModelAccessFact(product)} There is nothing to choose here.`,
        );
        process.stdout.write("\n");
        choices.provider = "harness-managed";
        return;
      }
      const copy = providerMenuCopy(harness);
      writeMenuRow(
        "  ",
        detection.aws.hasCredentials
          ? `Found AWS credentials (${aws.source}); ${
              aws.regionSource === "detected" ? "detected" : "fallback"
            } region ${aws.region}.`
          : "No AWS credentials were detected.",
      );
      writeMenuRow(
        "    1. keep current     ",
        "inherit the provider already configured in the harness (default)",
      );
      writeMenuRow("    2. amazon-bedrock   ", `${copy.bedrock}${
        detection.aws.hasCredentials ? " (AWS credentials detected)" : ""
      }`);
      const selected = promptChoice("  Provider", 2, 1);
      choices.provider = selected === 1 ? "current" : "amazon-bedrock";
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
        writeMenuRow(
          "  ",
          `Using amazon-bedrock in ${choices.region} with ${
            choices.profile || "the default credential chain"
          }.`,
        );
      } else {
        writeMenuRow(
          "  ",
          currentProviderNarration(
            modelHarness(choices.candidate.stamp.distribution),
          ).trimStart(),
        );
      }
      process.stdout.write("\n");
      return;
    }
    if (step === 3) {
      const previousPreset = choices.preset;
      process.stdout.write("  Step 3 of 6 - Model effort preset\n");
      if (choices.candidate.stamp.distribution === "kiro") {
        writeKiroPresetRows(choices.kiro ? choices.kiro.setModel?.id ?? choices.kiro.session.model : null);
      } else if (sessionSetsAgentModels(modelHarness(choices.candidate.stamp.distribution))) {
        writeMenuRow(
          "  ",
          `A preset changes nothing here: ${sessionModelsDetail(modelHarness(choices.candidate.stamp.distribution), null)}.`,
        );
        writeMenuRow("    1. balanced    ", "medium effort for deciding, reviewing, and writing up");
        writeMenuRow("    2. thorough    ", "session effort for deciding and writing up, extra-high reviewing");
        writeMenuRow("    3. minimal     ", "medium deciding and reviewing, low writing up");
        writeMenuRow("    4. unchanged   ", "records no preset (recommended, default)");
      } else {
        writeMenuRow("    1. balanced    ", "medium effort for deciding, reviewing, and writing up (recommended, default)");
        writeMenuRow("    2. thorough    ", "session effort for deciding and writing up, extra-high reviewing");
        writeMenuRow("    3. minimal     ", "medium deciding and reviewing, low writing up");
        writeMenuRow(
          "    4. unchanged   ",
          "records no preset and keeps existing settings; new projects use shipped defaults",
          "where agents inherit your session's model and effort",
        );
      }
      const selected = promptChoice(
        "  Preset",
        4,
        choices.preset === "balanced" ? 1 : choices.preset === "thorough" ? 2 : choices.preset === "minimal" ? 3 : 4,
      );
      choices.preset = selected === 1 ? "balanced" : selected === 2 ? "thorough" : selected === 3 ? "minimal" : "unchanged";
      process.stdout.write(choices.preset === "unchanged"
        ? "  Keeping existing settings unchanged; no preset recorded.\n\n"
        : `  Using the ${choices.preset} preset.\n\n`);
      if (previousPreset === "unchanged" && choices.preset !== "unchanged") {
        editStep(6);
      }
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
    process.stdout.write("  Step 6 of 6 - Where to record the model preset\n");
    if (choices.preset === "unchanged") {
      process.stdout.write("  Not applicable: no model preset will be recorded.\n\n");
      return;
    }
    writeMenuRow("    1. this project, committed     ", "aidlc.settings.json - shared with your team  (default)");
    writeMenuRow("    2. this project, just for you  ", "aidlc.settings.local.json - gitignored");
    writeMenuRow("    3. this machine                ", "every project you set up here");
    const selected = promptChoice(
      "  Preset in",
      3,
      choices.target === "project" ? 1 : choices.target === "local" ? 2 : 3,
    );
    choices.target = selected === 1 ? "project" : selected === 2 ? "local" : "global";
    process.stdout.write(`  Recording the model preset in ${firstRunSettingsTargetLabel(choices.target)}.\n\n`);
  };

  process.stdout.write("\n  Customize setup - 6 steps, Enter accepts the [default].\n\n");
  for (let step = 1; step <= 6; step++) editStep(step);
  while (true) {
    process.stdout.write("  Your choices - Enter to apply, or a number to change:\n");
    process.stdout.write(`    1. Harness      ${choices.candidate.descriptor.productName}\n`);
    const kiroCli = choices.candidate.stamp.distribution === "kiro";
    if (kiroCli) {
      // A harness changed to Kiro CLI here has not visited step 2: show the
      // session it would keep, read now; step 2 is one number away.
      if (choices.kiro === undefined) choices.kiro = kiroSessionFor("kiro");
      writeMenuRow("    2. Model        ", firstRunKiroSummary(choices.kiro));
    } else {
      writeMenuRow("    2. Provider     ", `${
        choices.provider === "amazon-bedrock"
          ? `amazon-bedrock, ${choices.region}, ${choices.profile || "default credential chain"}`
          : choices.provider === "harness-managed"
          ? `comes with ${choices.candidate.descriptor.productName}`
          : "keep current"
      }`);
    }
    process.stdout.write(`    3. Preset       ${
      choices.preset === "unchanged"
        ? "none (unchanged)"
        : kiroCli
        ? `${choices.preset} (${KIRO_EFFORT_LABEL[KIRO_PRESET_EFFORT[choices.preset]]} effort)`
        : choices.preset
    }\n`);
    process.stdout.write(`    4. Plugins      ${choices.pluginLabel}\n`);
    process.stdout.write(`    5. MCP          ${choices.mcp === "defaults" ? "on" : "off"}\n`);
    process.stdout.write(
      `    6. Preset in    ${
        choices.preset === "unchanged"
          ? "n/a (no preset recorded)"
          : firstRunSettingsTargetLabel(choices.target)
      }\n`,
    );
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
  // A pinned project is set up from its pinned release, as `config --harness`
  // is: the children below pass the chosen root as --from, and a source other
  // than the pin would be refused only after every question was answered. A
  // malformed pin, or a pinned release this machine lacks, leaves the wizard
  // to the regular path, which reports it before asking anything.
  const pinPath = join(projectDir, ".aidlc-version");
  const pinned = regularFile(pinPath) ? readFileSync(pinPath, "utf-8").trim() : undefined;
  if (pathPresent(pinPath) && (pinned === undefined || !VERSION_ID.test(pinned))) return false;
  const candidates = installedSourceCandidates(pinned);
  if (candidates.length === 0) return false;
  // Storage that cannot hold the transaction lock would fail at apply, after
  // every question; find out before asking any. Whatever the check hits (a
  // rejected link, a full disk, no write permission) stops setup here.
  try {
    assertTransactionFilesystem(projectDir);
  } catch (error) {
    process.stdout.write("\n");
    writeFirstRunFailureLines(firstRunFailureLines(
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        remediation: error instanceof TransactionFilesystemError ? error.remediation : undefined,
      }),
      `${configCommand()}${projectTarget(projectDir)}`,
    ));
    // A probe that could not be removed is named in the message above.
    const probeLeft = error instanceof AggregateError ||
      (error instanceof TransactionFilesystemError && error.cause instanceof AggregateError);
    process.stdout.write(probeLeft ? "  Nothing else was written.\n" : "  Nothing written.\n");
    process.exitCode = EXIT.failure;
    return true;
  }
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
  const inEditor = launchedFromCandidateEditor(candidate);
  writeMenuRow(
    "    Harness    ",
    `${candidate.descriptor.productName} ${
      harnessDetection?.found || inEditor ? "detected" : "selected"
    }${
      displayedVersion
        ? `  (${displayedVersion} on your PATH)`
        : inEditor
        ? `  (running in ${candidate.descriptor.productName}'s terminal)`
        : harnessDetection?.probed === false
        ? "  (CLI not probed)"
        : ""
    }`,
  );
  writeMenuRow(
    "    Project    ",
    `${
      existsSync(join(projectDir, ".git")) ? "git repo" : "project directory"
    }, no AI-DLC files yet`,
  );
  writeMenuRow(
    "    AWS        ",
    detection.aws.hasCredentials
      ? `credentials found  (${aws.source}, ${
          aws.regionSource === "detected" ? "detected" : "fallback"
        } region ${aws.region})`
      : "credentials not found",
  );
  writeMenuRow(
    "    Runtime    ",
    runtimeCount === 0
      ? "ready"
      : `${runtimeCount === 1 ? "one" : runtimeCount} PATH fix${
          runtimeCount === 1 ? "" : "es"
        } needed - shown at the end`,
  );
  process.stdout.write("\n");
  process.stdout.write(
    `  Set up AI-DLC for ${candidate.descriptor.productName} with recommended defaults?\n\n`,
  );
  const recommended = "    1. Yes, use recommended defaults   ";
  const recommendedDetail = " ".repeat(recommended.length);
  writeMenuRow(
    recommended,
    `${
      candidate.stamp.distribution === "claude" ? "MCP servers on, " : ""
    }all plugins, ${
      harnessOwnsModelAccess(modelHarness(candidate.stamp.distribution))
        ? `no provider settings; model access comes with ${candidate.descriptor.productName}`
        : "current model provider preserved"
    }`,
  );
  if (HARNESS_HONESTY[modelHarness(candidate.stamp.distribution)].groupEffort) {
    writeMenuRow(
      recommendedDetail,
      "Records balanced (default): medium project agent effort for deciding,",
      "reviewing, and writing up; your session (conductor) effort stays unchanged.",
    );
  } else if (candidate.stamp.distribution === "kiro") {
    writeMenuRow(
      recommendedDetail,
      "Records balanced (default): medium effort for the whole Kiro session, saved in your personal Kiro settings for every Kiro project.",
    );
  } else if (sessionSetsAgentModels(modelHarness(candidate.stamp.distribution))) {
    writeMenuRow(
      recommendedDetail,
      `Records no model preset: ${sessionModelsDetail(modelHarness(candidate.stamp.distribution), null)}.`,
    );
  } else {
    writeMenuRow(recommendedDetail, "Records balanced (default).");
    writeMenuRow(
      recommendedDetail,
      `In ${candidate.descriptor.productName}, effort dials do not apply, so agents keep your session's effort.`,
    );
  }
  writeMenuRow(
    "    2. No, customize step by step      ",
    "harness, provider, preset, plugins, MCP, record layer",
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
      provider: harnessOwnsModelAccess(modelHarness(candidate.stamp.distribution))
        ? "harness-managed"
        : "current",
      region: aws.region,
      profile: "",
      preset: firstRunDefaultPreset(candidate.stamp.distribution),
      plugins: "all",
      pluginLabel: "all installed",
      mcp: candidate.stamp.distribution === "claude" ? "defaults" : "none",
      target: "project",
      providerVerified: detection.bedrockReachable === true,
      opencodeDefault: true,
    };
    // The recommended defaults include a named session model, so Kiro auto
    // asks the one model question; a named model asks nothing.
    if (candidate.stamp.distribution === "kiro") {
      choices.kiro = kiroSessionFor(candidate.stamp.distribution);
      const current = choices.kiro?.session.model ?? null;
      if (choices.kiro && (!current || kiroModelRetired(choices.kiro))) {
        process.stdout.write("\n");
        choices.kiro.setModel = chooseKiroSessionModel(
          choices.kiro,
          "balanced",
          current
            ? kiroRetiredIntro(current)
            : `You're on ${KIRO_AUTO_DEFINITION}. ${
              kiroAutoRecommendation(null)
            } Choose the session model (Enter takes the recommended one):`,
        );
      }
    }
  } else {
    choices = customizeFirstRun(candidate, candidates, detection);
  }
  if (!choices) return true;
  const snapshot = snapshotFirstRunMutationPaths(projectDir, choices);
  let preserveSnapshot = false;
  try {
    applyFirstRunChoices(projectDir, choices, snapshot);
    // Personal Kiro settings sit outside the rollback snapshot, so they are
    // written last, once every AI-DLC step has succeeded.
    const kiroResult = await applyFirstRunKiroSession(choices);
    renderFirstRunEnding(projectDir, choices, kiroResult);
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
    process.stdout.write("\n");
    writeFirstRunFailureLines(firstRunFailureLines(
      error instanceof Error ? error.message : String(error),
      `${configCommand()}${projectTarget(projectDir)}`,
    ));
    process.stdout.write("  No setup changes were kept.\n");
    process.exitCode = EXIT.failure;
  } finally {
    if (!preserveSnapshot) snapshot.cleanup();
  }
  return true;
  } catch (error) {
    if (error instanceof FirstRunCancelled) {
      process.stdout.write(noAnswerLines(error, configCommand(projectTarget(projectDir)), true));
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
  if (!requested && harnesses.length > 1) {
    throw new Error("multiple project harnesses are present; pass one --harness <name>");
  }
  const harness = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];

  if (!harness) return {};
  const baselinePath = join(harness.root, "tools", "data", "aidlc-manifest.json");
  const baseline = readBaseline(baselinePath);
  if (baseline && !baselineNamesHarness(baseline, harness)) {
    throw new Error(`${baselinePath}: baseline identity does not match the installed harness`);
  }
  return {
    distribution: harness.distribution,
    ...(baseline ? { baseline } : {}),
  };
}

// The workspace directory holds the project's records and its per-machine
// runtime state (clone id, sessions, engine health, sensor caches). A release
// ships only its seeds there, so no other path under it is release content:
// such a path in a source tree (a runtime payload a hook once wrote into, or a
// copied project's own records) is never copied or baselined, and a baseline
// entry recorded for one is dropped rather than retired.
function workspaceSeed(rel: string): boolean {
  return rel === "aidlc/active-space" || /^aidlc\/spaces\/[^/]+\/memory\//.test(rel);
}

function workspaceState(rel: string): boolean {
  return rel.startsWith("aidlc/") && !workspaceSeed(rel);
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
  retainBaseline: boolean,
  projectOverlays: ReadonlySet<string> = new Set(),
  unproven: ReadonlySet<string> = new Set(),
): void {
  const shipped = new Set<string>();
  for (const directory of descriptor.managedDirectories) {
    const sourceDir = join(sourceRoot, directory);
    if (!existsSync(sourceDir)) throw new Error(`projection is missing managed directory ${directory}`);
    for (const nested of walkFiles(sourceDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      if (workspaceState(rel)) continue;
      shipped.add(rel);
      const source = join(sourceRoot, rel);
      const target = join(projectDir, rel);
      const targetExists = pathPresent(target);
      const targetRegular = targetExists && lstatSync(target).isFile();
      const hash = sha256File(source);
      const priorHash = prior?.files[rel];
      // A copy Git checked out with other line endings is the file it was.
      const currentHash = targetRegular
        ? sha256FileMatching(target, [hash, priorHash, ...(descriptor.legacyManagedFileHashes?.[rel] ?? [])])
        : undefined;
      const adoptedManagedFile = prior === null &&
        currentHash !== undefined &&
        (
          descriptor.legacyManagedFileHashes?.[rel]?.includes(
            currentHash,
          ) ?? false
        );
      if (workspaceSeed(rel)) {
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
      const projectOwned = projectOverlays.has(rel);
      if (projectOwned && targetRegular && currentHash === hash) {
        actions.push({ path: rel, action: "preserve", detail: "project-owned" });
        continue;
      }
      if (!projectOwned && !unbaselinedGenerated(descriptor.harnessDir).includes(rel)) {
        // In-place answers can advance ownership only from an unmodified base.
        const nextHash = retainBaseline
          ? regenerated.has(rel) && targetRegular && currentHash === priorHash ? hash : priorHash
          : hash;
        if (nextHash !== undefined) nextHashes[rel] = nextHash;
      }
      if (runtimeGenerated(rel, descriptor.harnessDir, regenerated)) {
        if (targetRegular && currentHash === hash) {
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
      if (targetRegular && currentHash === hash) {
        actions.push({ path: rel, action: "preserve" });
        continue;
      }
      if (
        targetExists &&
        (
          !targetRegular ||
          unproven.has(rel) ||
          (!adoptedManagedFile && (!priorHash || currentHash !== priorHash))
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
    // An earlier manifest may have taken over a host tool's own files; they
    // stay the tool's.
    if (
      shipped.has(rel) ||
      workspaceState(rel) ||
      hostToolPath(rel) ||
      rel.endsWith("/tools/data/aidlc-manifest.json")
    ) continue;
    const target = join(projectDir, rel);
    if (!pathPresent(target)) continue;
    if ((!regularFile(target) || sha256FileMatching(target, [priorHash]) !== priorHash) && !force) {
      actions.push({ path: rel, action: "conflict", detail: "removed upstream but locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path: rel, expected: expected(target) });
    actions.push({ path: rel, action: "remove", detail: NO_LONGER_SHIPPED });
  }
}

// A refresh names every file it removes because the release no longer ships
// it, on dry run and apply alike. Several files in one folder are one line, so
// a retired skill or knowledge folder stays readable.
const NO_LONGER_SHIPPED = "no longer shipped";
const RETIRED_LIST_LINES = 10;

function retiredFilesReport(
  projectDir: string,
  actions: readonly PlannedAction[],
  version: string,
  removed: boolean,
  // On an in-place switch the files go because the other row does not ship
  // them, not because AI-DLC dropped them.
  switched?: { from: string; to: string },
): string[] {
  const paths = actions
    .filter((item) => item.action === "remove" && item.detail === NO_LONGER_SHIPPED)
    .map((item) => item.path)
    .sort();
  if (paths.length === 0) return [];
  const byFolder = new Map<string, string[]>();
  for (const path of paths) {
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
  }
  // Each path is shown as it would be typed, so no control character in a
  // recorded name reaches the terminal.
  const rows = [...byFolder].flatMap(([folder, files]) =>
    folder && files.length > 1
      ? [{ line: `${quoteCommandArgument(folder)} (${files.length} files)`, files: files.length }]
      : files.map((file) => ({ line: quoteCommandArgument(file), files: 1 }))
  );
  const shown = rows.length > RETIRED_LIST_LINES ? rows.slice(0, RETIRED_LIST_LINES - 1) : rows;
  const more = rows.slice(shown.length).reduce((sum, row) => sum + row.files, 0);
  const lines = [
    switched
      ? `${removed ? "Removed" : "Will remove"} ${paths.length === 1 ? "1 file" : `${paths.length} files`} that ${
        switched.from
      } ships and ${switched.to} does not:`
      : `${removed ? "Removed" : "Will remove"} ${
        paths.length === 1 ? "1 file that is" : `${paths.length} files that are`
      } no longer part of AI-DLC ${version}:`,
    ...shown.map((row) => `  ${row.line}`),
    ...(more > 0 ? [`  and ${more} more files`] : []),
  ];
  // The command runs from the same shell, so it names the project when this
  // did not run from it, and is printed only when it means exactly what it
  // says: every name is plain text the shell and git read literally (as every
  // release's are), and the project can be written out.
  const plain = (path: string) => quoteCommandArgument(path) === path && !/^[-:]/.test(path);
  if (
    paths.every(plain) &&
    (ranFromProject(projectDir) || !hasControlCharacters(projectDir)) &&
    insideGitRepository(projectDir) &&
    gitTracksEvery(projectDir, paths)
  ) {
    const git = ranFromProject(projectDir) ? "git" : `git -C ${quoteCommandArgument(projectDir)}`;
    lines.push(
      paths.length === 1
        ? `To get it back, run \`${git} restore ${paths[0]}\`.`
        : `To get one back, run \`${git} restore <path>\`.`,
    );
  }
  return lines;
}

// The way back is named only when it works: git tracks every removed file.
function gitTracksEvery(projectDir: string, paths: readonly string[]): boolean {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  // One pathspec per top-level entry keeps the command line short.
  const tops = [...new Set(paths.map((path) => path.split("/")[0]))];
  const listed = spawnSync(
    "git",
    // A repository's fsmonitor program is never run just to word this line.
    ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", projectDir, "ls-files", "-z", "--", ...tops],
    { encoding: "utf-8", env, timeout: 10_000 },
  );
  if (listed.status !== 0) return false;
  const tracked = new Set(listed.stdout.split("\0"));
  return paths.every((path) => tracked.has(path));
}

// The project's MCP file already holds a server a release shipped, as shipped.
function holdsShippedServers(projectDir: string, descriptor: Pick<ProjectionDescriptor, "rootIntegrations">): boolean {
  for (const integration of descriptor.rootIntegrations) {
    if (integration.policy !== "json-map" || !integration.optional) continue;
    const path = join(projectDir, integration.path);
    try {
      if (!lstatSync(path).isFile()) continue;
      const map = (readJsonFile(path) as Record<string, unknown>)[integration.jsonKey ?? ""];
      if (!isRecord(map)) continue;
      for (const [entry, hashes] of Object.entries(integration.legacySignatures?.jsonEntryHashes ?? {})) {
        if (entry in map && hashes.includes(sha256Bytes(canonical(map[entry])))) return true;
      }
    } catch {
      // A missing or unreadable file holds none.
    }
  }
  return false;
}

// Two JSON texts with the same value, byte order mark and layout aside.
function sameJsonText(left: string, right: string): boolean {
  try {
    return canonical(JSON.parse(withoutBom(left))) === canonical(JSON.parse(withoutBom(right)));
  } catch {
    return false;
  }
}

function planRootIntegrations(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  mcpMode: "defaults" | "none",
  force: boolean,
  recordOnly: boolean,
  retainBaseline: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  contributions: Record<string, RootContribution>,
  // The source is the project's own files, not a release: a json-map entry is
  // recorded as shipped only when its bytes are a release's (the descriptor's
  // signatures), so a user's edit is never adopted as the framework's.
  ownBytes = false,
  // MCP is on because the project already has the shipped servers: keep and
  // update those, and add none it does not have.
  keepPresent = false,
  // The source is the project's own copied tree, whose json-entries file is
  // the team's own with AI-DLC's part merged in.
  ownJsonEntries = ownBytes,
): void {
  let siblings: ProjectHarness[] | undefined;
  let siblingProjections: Array<{
    sibling: ProjectHarness;
    descriptor: Pick<ProjectionDescriptor, "rootIntegrations"> | null;
  }> | undefined;
  for (const integration of descriptor.rootIntegrations) {
    // The shipped list a copy starts without travels in root-blocks; config run
    // from the project's own files merges it into the team's file, if any.
    const shippedCopy = ownBytes && copyStartsWithout(integration)
      ? rootBlockPath(join(sourceRoot, descriptor.harnessDir), integration)
      : "";
    // Read only through no symlink, so the copy cannot point at another file.
    let fromShippedCopy = shippedCopy !== "" && regularFile(shippedCopy);
    if (fromShippedCopy) {
      try {
        assertProjectionPathHasNoSymlinks(sourceRoot, relative(sourceRoot, shippedCopy).split(sep).join("/"));
      } catch {
        fromShippedCopy = false;
      }
    }
    const sourcePath = fromShippedCopy
      ? shippedCopy
      : shippedRootIntegrationPath(sourceRoot, descriptor.harnessDir, integration);
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
    const currentBytes = targetRegular ? readFileSync(targetPath) : Buffer.alloc(0);
    const current = currentBytes.toString("utf-8");
    if (integration.path === ".gitignore" && !Buffer.from(current, "utf-8").equals(currentBytes)) {
      actions.push({
        path: integration.path,
        action: "conflict",
        detail: "gitignore is not valid UTF-8; convert its encoding before config",
      });
      continue;
    }
    const priorContribution = prior?.rootContributions[integration.path];
    if (integration.policy === "managed-block") {
      const marker = integration.marker || basename(integration.path);
      let shipped = readFileSync(sourcePath, "utf-8");
      let legacyWholeFileHashes = integration.legacySignatures?.wholeFileHashes;
      let contributingSiblings: Set<ProjectHarness> | undefined;
      let missingCopy: ProjectHarness | undefined;
      if (integration.shared === "union") {
        siblings ??= discoverProjectHarnesses(projectDir);
        siblingProjections ??= siblings
          .filter((sibling) => sibling.harnessDir !== descriptor.harnessDir)
          .map((sibling) => ({ sibling, descriptor: siblingDescriptor(sibling) }));
        const contributors = [{ distribution: descriptor.distribution, text: shipped }];
        const legacyHashes = new Set(legacyWholeFileHashes);
        contributingSiblings = new Set();
        for (const { sibling, descriptor: siblingProjection } of siblingProjections) {
          const siblingIntegration = siblingProjection?.rootIntegrations.find(
            (candidate) => candidate.path === integration.path,
          );
          for (const hash of siblingIntegration?.legacySignatures?.wholeFileHashes ?? []) {
            legacyHashes.add(hash);
          }
          try {
            const path = rootBlockPath(sibling.root, integration);
            if (!regularFile(path)) {
              if (siblingIntegration?.shared === "union") missingCopy ??= sibling;
              continue;
            }
            contributors.push({ distribution: sibling.distribution, text: readFileSync(path, "utf-8") });
            contributingSiblings.add(sibling);
          } catch {
            // Older or unreadable installations do not contribute shipped blocks.
            if (siblingIntegration?.shared === "union") missingCopy ??= sibling;
          }
        }
        shipped = unionBlocks(contributors);
        legacyWholeFileHashes = [...legacyHashes];
      }
      siblings ??= discoverProjectHarnesses(projectDir);
      const merged = mergeBlock(
        integration.path,
        current,
        shipped,
        marker,
        legacyWholeFileHashes,
        [priorContribution, ...siblings.map((sibling) => siblingBaseline(sibling)?.rootContributions?.[integration.path])]
          .map((contribution) => contribution?.policy === "managed-block" ? contribution.hash : undefined),
      );
      if (merged.error) {
        actions.push({ path: integration.path, action: "conflict", detail: merged.error });
        continue;
      }
      if (missingCopy && !force && merged.value !== current) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: `${missingCopy.distribution} is missing its shipped block copy (${missingCopy.harnessDir}/tools/data/root-blocks/${marker}); run aidlc config --harness ${missingCopy.distribution} first`,
        });
        continue;
      }
      const value = merged.value as string;
      const priorHash = priorContribution?.policy === "managed-block"
        ? priorContribution.hash
        : undefined;
      let combinedWith: string | undefined;

      if (
        merged.currentHash &&
        merged.currentHash !== merged.nextHash &&
        merged.currentHash !== priorHash &&
        !force
      ) {
        siblings ??= discoverProjectHarnesses(projectDir);
        const owner = siblings.find((sibling) => {
          if (sibling.harnessDir === descriptor.harnessDir) return false;
          const contribution = siblingBaseline(sibling)?.rootContributions?.[integration.path];
          return contribution?.policy === "managed-block" && contribution.hash === merged.currentHash;
        });
        if (owner && integration.shared) {
          if (integration.shared === "identical") {
            actions.push({
              path: integration.path,
              action: "conflict",
              detail: `shared block is owned by ${owner.distribution} from a different release; refresh ${descriptor.distribution} from the same release as ${owner.distribution}, or refresh ${owner.distribution} from this release first`,
            });
            continue;
          }
          if (contributingSiblings?.has(owner)) {
            combinedWith = owner.distribution;
          } else {
            actions.push({ path: integration.path, action: "preserve", detail: `owned by ${owner.distribution}` });
            continue;
          }
        } else if (priorHash || !merged.currentBlockShipped) {
          // A part that is exactly what a release shipped (one a copy added
          // before config ran) is AI-DLC's own even without a record.
          actions.push({
            path: integration.path,
            action: "conflict",
            detail: priorHash ? "managed block was locally modified" : "managed block has no ownership baseline",
          });
          continue;
        }
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
          detail: merged.keptOwnLines
            ? KEPT_GITIGNORE_LINES_DETAIL
            : combinedWith
            ? `combined with ${combinedWith}`
            : merged.adoptedLegacy ? "adopted exact legacy signature" : undefined,
        });
      }
      continue;
    }
    if (integration.policy === "json-map") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(withoutBom(current)) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
        // Claude's copy in the harness folder takes the recorded region here.
        if (
          descriptor.distribution === "claude" && sourcePath !== join(sourceRoot, integration.path) &&
          isRecord(sourceValue)
        ) {
          withRecordedMcpRegion(sourceValue, recordedProviders(sourceRoot, descriptor.harnessDir));
        }
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
      const shippedHashes = integration.legacySignatures?.jsonEntryHashes ?? {};
      // From the shipped copy in root-blocks, its entries are added as shipped
      // next to the team's own; from the project's own file, only entries a
      // release shipped are recorded as AI-DLC's.
      if (mcpMode === "defaults" && ownBytes && !fromShippedCopy) {
        for (const entry of Object.keys(sourceMap)) {
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if ((shippedHashes[entry] ?? []).includes(currentHash)) nextEntries[entry] = currentHash;
        }
      } else if (mcpMode === "defaults") {
        for (const [entry, value] of Object.entries(sourceMap)) {
          const desiredHash = sha256Bytes(canonical(value));
          if (!(entry in targetMap)) {
            if (keepPresent) continue;
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
        // With no baseline yet, the servers a release shipped are known by their
        // signatures: turning MCP off removes those, unedited, and nothing else.
        if (priorContribution?.policy !== "json-map") {
          for (const [entry, hashes] of Object.entries(shippedHashes)) {
            if (entry in targetMap && hashes.includes(sha256Bytes(canonical(targetMap[entry])))) {
              delete targetMap[entry];
            }
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
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(withoutBom(current)) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        const value = jsonFileText(target, current);
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    if (integration.policy === "jsonc-settings") {
      // A team's settings file (.vscode/settings.json): add each shipped key
      // that is absent, follow a key AI-DLC added while nobody changed it, and
      // never touch a value the team set, other keys, or comments (#1411).
      // The copy runtime ships no such file, so its refresh leaves both the
      // file and AI-DLC's record as they are.
      if (!regularFile(sourcePath)) {
        if (priorContribution) contributions[integration.path] = priorContribution;
        continue;
      }
      const shippedText = readFileSync(sourcePath, "utf-8");
      const shippedKeys = jsoncRootMembers(shippedText)?.members.map((member) => member.key) ?? [];
      const priorEntries = priorContribution?.policy === "jsonc-settings" ? priorContribution.entries : {};
      // Keys AI-DLC added at some point. One the team then took out of a file
      // it kept is the team's choice, so it is not added back; a clone with no
      // file at all (.vscode/ is outside git by default) still gets it.
      const priorAdded = new Set(priorContribution?.policy === "jsonc-settings"
        ? [...(priorContribution.added ?? []), ...Object.keys(priorEntries)]
        : []);
      const nextAdded = new Set<string>();
      if (current.trim() && !jsoncRootMembers(current)) {
        // Unreadable here is the team's to fix; config carries on and doctor says so.
        if (priorContribution) contributions[integration.path] = priorContribution;
        actions.push({ path: integration.path, action: "preserve", detail: "not a JSONC object; left unchanged" });
        continue;
      }
      let value = current;
      const nextEntries: Record<string, string> = {};
      for (const key of shippedKeys) {
        const shipped = jsoncSettingValue(shippedText, key);
        const shippedJson = JSON.stringify(shipped);
        const shippedHash = sha256Bytes(canonical(shipped));
        const present = jsoncRootMembers(value)?.members.some((member) => member.key === key) ?? false;
        if (!present && targetExists && priorAdded.has(key)) {
          nextAdded.add(key);
          continue;
        }
        if (!present) {
          value = insertJsoncSetting(value, key, shippedJson) ?? value;
          nextEntries[key] = shippedHash;
          nextAdded.add(key);
          continue;
        }
        if (priorAdded.has(key)) nextAdded.add(key);
        const priorHash = priorEntries[key];
        if (priorHash && settingHash(jsoncSettingValue(value, key)) === priorHash) {
          if (priorHash !== shippedHash) value = replaceJsoncSetting(value, key, shippedJson) ?? value;
          nextEntries[key] = shippedHash;
        }
      }
      for (const [key, priorHash] of Object.entries(priorEntries)) {
        if (shippedKeys.includes(key)) continue;
        if (settingHash(jsoncSettingValue(value, key)) === priorHash) {
          value = removeJsoncSetting(value, key) ?? value;
        }
      }
      // AI-DLC created the file now, or created it before and it is still there.
      const created = !targetExists ||
        (priorContribution?.policy === "jsonc-settings" && priorContribution.created === true);
      contributions[integration.path] = {
        policy: "jsonc-settings",
        entries: nextEntries,
        ...(nextAdded.size > 0 ? { added: [...nextAdded].sort() } : {}),
        ...(created ? { created: true } : {}),
      };
      if (value === current) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    if (integration.policy === "json-entries") {
      // A team's own JSON file (opencode.json): AI-DLC adds its entries that
      // are absent, follows the ones it wrote while nobody changed them, and
      // removes only those it no longer ships. The team's keys, values,
      // comments, and layout stay as they are.
      const shippedText = readFileSync(sourcePath, "utf-8");
      const legacy = integration.legacySignatures?.wholeFileHashes ?? [];
      const recordedHashes = [...legacy, priorContribution?.policy === "whole-file" ? priorContribution.hash : undefined];
      const currentHash = sha256Matching(current, recordedHashes);
      const bareHash = sha256Matching(withoutBom(current), recordedHashes);
      const legacyMatch = legacy.includes(currentHash) || legacy.includes(bareHash);
      let ownership: JsonEntriesOwnership;
      if (priorContribution?.policy === "json-entries") {
        ownership = { kind: "recorded", entries: priorContribution.entries };
      } else if (priorContribution?.policy === "whole-file") {
        // A file AI-DLC wrote whole: still as written, or edited since.
        ownership = priorContribution.hash === currentHash || priorContribution.hash === bareHash || legacyMatch
          ? { kind: "whole" }
          : { kind: "matching" };
      } else {
        // From the project's own files the "shipped" file is the team's file
        // itself, so matching it proves nothing: only entries naming AI-DLC's
        // own folders are read as AI-DLC's, as at the first session.
        ownership = legacyMatch || (!ownJsonEntries && sameJsonText(current, shippedText))
          ? { kind: "whole" }
          : { kind: "none" };
      }
      const merged = mergeJsonEntries(current, shippedText, ownership, force);
      if ("conflict" in merged) {
        actions.push({ path: integration.path, action: "conflict", detail: merged.conflict });
        continue;
      }
      const created = !targetExists || priorContribution?.policy === "whole-file" ||
        (priorContribution?.policy === "json-entries" && priorContribution.created === true);
      contributions[integration.path] = {
        policy: "json-entries",
        entries: merged.entries,
        ...(created ? { created: true } : {}),
      };
      if (merged.text === current) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(integration.path, merged.text, expected(targetPath)));
        actions.push({
          path: integration.path,
          action: !targetExists ? "create" : merged.whole ? "update" : "merge",
          detail: legacyMatch && priorContribution?.policy !== "json-entries" ? "adopted exact legacy signature" : undefined,
        });
      }
      continue;
    }
    if (integration.policy === "json-array") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(withoutBom(current)) : {};
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
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(withoutBom(current)) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(
          integration.path,
          jsonFileText(targetValue, current),
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
    // Nor are a byte order mark the person's editor added, or line endings Git rewrote.
    const currentHash = sha256Matching(current, [shippedHash, priorHash, ...(integration.legacySignatures?.wholeFileHashes ?? [])]);
    const owned = currentHash === priorHash ||
      (withoutBom(current) !== current && sha256Matching(withoutBom(current), [priorHash]) === priorHash);
    const adoptedLegacy = integration.legacySignatures?.wholeFileHashes?.includes(currentHash) ?? false;
    if (!retainBaseline || owned) {
      contributions[integration.path] = { policy: "whole-file", hash: shippedHash };
    } else if (priorContribution) {
      contributions[integration.path] = priorContribution;
    }
    if (
      !recordOnly &&
      targetExists &&
      !owned &&
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
      actions.push({ path, action: "remove", detail: NO_LONGER_SHIPPED });
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
      if (sha256Matching(text.slice(beginAt, blockEnd), [contribution.hash]) !== contribution.hash && !force) {
        actions.push({ path, action: "conflict", detail: "retired managed block was locally modified" });
        continue;
      }
      let value = `${text.slice(0, beginAt)}${text.slice(blockEnd)}`;
      value = value.replace(/^\r?\n/, "").replace(/\r?\n\r?\n$/, "\n");
      if (!value) {
        operations.push({ kind: "remove", path, expected: expected(targetPath) });
        actions.push({ path, action: "remove", detail: NO_LONGER_SHIPPED });
      } else {
        operations.push(writeOperation(path, value, expected(targetPath)));
        actions.push({ path, action: "merge", detail: "removed retired managed block" });
      }
      continue;
    }
    if (contribution.policy === "json-map") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(withoutBom(text));
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
      operations.push(writeOperation(path, jsonFileText(parsed, text), expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON entries" });
      continue;
    }
    if (contribution.policy === "jsonc-settings") {
      // Remove only the settings AI-DLC added and nobody has changed since.
      let value = text;
      for (const [key, priorHash] of Object.entries(contribution.entries)) {
        if (settingHash(jsoncSettingValue(value, key)) === priorHash) {
          value = removeJsoncSetting(value, key) ?? value;
        }
      }
      if (value === text) {
        actions.push({ path, action: "preserve", detail: "retired settings were changed or already removed" });
      } else if (contribution.created && jsoncRootMembers(value)?.members.length === 0 && value.replace(/\s/g, "") === "{}") {
        operations.push({ kind: "remove", path, expected: expected(targetPath) });
        actions.push({ path, action: "remove", detail: NO_LONGER_SHIPPED });
      } else {
        operations.push(writeOperation(path, value, expected(targetPath)));
        actions.push({ path, action: "merge", detail: "removed retired settings" });
      }
      continue;
    }
    if (contribution.policy === "json-entries") {
      // Remove only the entries AI-DLC wrote and nobody has changed since.
      const value = removeJsonEntries(text, contribution.entries, force);
      if (value === null) {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
      } else if (value === text) {
        actions.push({ path, action: "preserve", detail: "retired entries were changed or already removed" });
      } else if (contribution.created && emptyJsonObject(value)) {
        operations.push({ kind: "remove", path, expected: expected(targetPath) });
        actions.push({ path, action: "remove", detail: NO_LONGER_SHIPPED });
      } else {
        operations.push(writeOperation(path, value, expected(targetPath)));
        actions.push({ path, action: "merge", detail: "removed retired JSON entries" });
      }
      continue;
    }
    if (contribution.policy === "json-array") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(withoutBom(text));
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
      operations.push(writeOperation(path, jsonFileText(parsed, text), expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON array entries" });
      continue;
    }
    if (sha256FileMatching(targetPath, [contribution.hash]) !== contribution.hash && !force) {
      actions.push({ path, action: "conflict", detail: "retired whole-file integration was locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path, expected: expected(targetPath) });
    actions.push({ path, action: "remove", detail: NO_LONGER_SHIPPED });
  }
}

type KiroModelsPlan =
  | { plan: KiroSessionPlan | null; note?: string }
  | { error: ReturnType<typeof failure> };

// The Kiro CLI session write for a `config models` run. Setup's own children
// defer it: first-run setup writes the session itself, last.
function kiroModelsPlan(input: {
  setModel?: string;
  preset: KiroPreset | null;
  fetchLevels: boolean;
  keepExistingEffort: boolean;
  kiro?: FirstRunKiroSession | null;
}): KiroModelsPlan {
  // Set by first-run setup for its own config children; a project .env that
  // sets it is ignored, so it cannot swallow an explicit request.
  if (process.env.AIDLC_CONFIG_DEFER_KIRO_SESSION === "1" && !setByDotenvFile("AIDLC_CONFIG_DEFER_KIRO_SESSION")) {
    return { plan: null };
  }
  const kiro = input.kiro ?? kiroSessionFor("kiro");
  if (!kiro) {
    if (input.setModel) {
      return {
        error: failure(
          "Kiro CLI settings could not be read, so the session model was not saved",
          EXIT.failure,
          "check that `kiro-cli settings list` works, then run this again",
        ),
      };
    }
    return {
      plan: null,
      ...(input.preset
        ? {
          note: `Kiro CLI settings could not be read, so the ${input.preset} preset's session effort was not saved. Run \`${
            configCommand("models")
          }\` again once \`kiro-cli\` works.`,
        }
        : {}),
    };
  }
  if (input.setModel) {
    const list = listKiroModels(kiro.cli);
    if (!list.ok) {
      return {
        error: failure(
          `Could not fetch your Kiro models (${list.reason}), so ${input.setModel} could not be checked and was not saved`,
          EXIT.failure,
          "run this again when Kiro answers",
        ),
      };
    }
    if (!list.models.some((model) => model.id === input.setModel)) {
      return {
        error: usage(
          `${input.setModel} is not offered on your Kiro account`,
          configCommand("models"),
        ),
      };
    }
  }
  return {
    plan: {
      cli: kiro.cli,
      session: kiro.session,
      ...(input.setModel ? { setModel: input.setModel } : {}),
      preset: input.preset,
      fetchLevels: input.fetchLevels,
      keepExistingEffort: input.keepExistingEffort,
      modelsCommand: configCommand("models"),
      doctorCommand: `${aidlcInvocation()} doctor`,
    },
  };
}

// `config models` on Kiro CLI, asked before anything else: the session model
// needs no record target, and a preset continues as `--preset <name>`.
function kiroModelsMenu(
  current: ModelPolicyRecord | null,
  kiro: FirstRunKiroSession | null,
): "keep" | "session" | KiroPreset | "unchanged" {
  const preset = isKiroPreset(current?.preset) ? current.preset : null;
  const model = kiro ? kiro.session.model : null;
  writeMenuRow(
    "  Session model   ",
    kiro
      ? model
        ? kiroModelRetired(kiro)
          ? `${model}, not offered on your Kiro account any more (every prompt fails)`
          : `${model}, from your personal Kiro settings`
        : KIRO_AUTO_DEFINITION
      : "not read (Kiro settings could not be read)",
  );
  writeMenuRow(
    "  Preset          ",
    preset
      ? `${preset}: ${KIRO_EFFORT_LABEL[KIRO_PRESET_EFFORT[preset]]} effort${model ? `, for ${model}` : ""}`
      : "none recorded",
  );
  if (kiro && !model) writeMenuRow("  ", kiroAutoRecommendation(preset));
  const choice = configPrompt("Models [Enter keep everything, 1 session model, 2 preset]:")?.trim();
  if (!choice) return "keep";
  if (choice === "1") return "session";
  if (choice !== "2") throw new Error("models selection cancelled");
  writeKiroPresetRows(model, "models");
  const selected = promptChoice(
    "  Preset",
    4,
    preset === "thorough" ? 2 : preset === "minimal" ? 3 : 1,
  );
  return selected === 1 ? "balanced" : selected === 2 ? "thorough" : selected === 3 ? "minimal" : "unchanged";
}

function writeKiroSessionLines(lines: readonly string[]): void {
  for (const line of lines) {
    if (/^\s/.test(line)) process.stdout.write(`  ${line}\n`);
    else writeMenuRow("  ", line);
  }
}

function kiroSessionData(result: KiroSessionResult): Record<string, unknown> {
  return {
    kiroSession: {
      ok: result.ok,
      model: result.model,
      effort: result.effort,
      saved: result.saved,
      lines: result.lines,
    },
  };
}

async function emitKiroSessionResult(
  result: KiroSessionResult,
  options: ReturnType<typeof globalOptions>,
): Promise<void> {
  if (options.mode === "human") writeKiroSessionLines(result.lines);
  emitResult(
    result.ok
      ? success(
        result.saved.model || result.saved.effort ? "saved the Kiro session model" : "session model unchanged",
        kiroSessionData(result),
      )
      : {
        ...failure(
          result.saved.model
            ? `Kiro saved the session model ${result.saved.model} but not its effort`
            : "the Kiro session model was not saved",
          EXIT.actionNeeded,
          configCommand("models"),
        ),
        status: "action-needed",
        data: kiroSessionData(result),
      },
    options,
  );
}

type PreparedModelsSection =
  | { argv: string[]; context: ModelsMutationContext; kiro?: KiroSessionPlan; kiroNote?: string }
  | { kiroOnly: KiroSessionPlan };

function prepareModelsSection(
  argv: string[],
  options: ReturnType<typeof globalOptions>,
): PreparedModelsSection | null {
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
    "--session-model",
    "--writing-up-effort",
  ];
  let hasMutationFlags = mutationFlags.some((flag) => argv.includes(flag));
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
            modelsCommand(projectDir, harness, "--show"),
          ),
      options,
    );
    return null;
  }

  const kiroCli = selected.distribution === "kiro";
  const sessionModel = valueAfter(argv, "--session-model");
  if (sessionModel !== undefined && !kiroCli) {
    emitResult(
      usage("--session-model applies to Kiro CLI projects only", configCommand("models --help")),
      options,
    );
    return null;
  }
  const currentKiroPreset = isKiroPreset(current?.preset) ? current.preset : null;
  if (kiroCli && !hasMutationFlags && configInputIsTty()) {
    const kiro = kiroSessionFor(selected.distribution);
    const pick = kiroModelsMenu(current, kiro);
    if (pick === "keep" || pick === "unchanged") {
      emitResult(success("model policy unchanged"), options);
      return null;
    }
    if (pick === "session") {
      if (!kiro) {
        emitResult(
          failure(
            "Kiro CLI settings could not be read, so the session model cannot be chosen",
            EXIT.failure,
            "check that `kiro-cli settings list` works, then run this again",
          ),
          options,
        );
        return null;
      }
      askKiroSessionModel(kiro, currentKiroPreset);
      if (!kiro.setModel) {
        emitResult(success("session model unchanged"), options);
        return null;
      }
      const planned = kiroModelsPlan({
        kiro,
        setModel: kiro.setModel.id,
        preset: currentKiroPreset,
        fetchLevels: true,
        keepExistingEffort: false,
      });
      if ("error" in planned) {
        emitResult(planned.error, options);
        return null;
      }
      return planned.plan ? { kiroOnly: planned.plan } : null;
    }
    argv = [...argv, "--preset", pick];
    hasMutationFlags = true;
  }
  // `--session-model` alone saves the person's Kiro session and records nothing
  // in AI-DLC's settings, so it needs no record target.
  const policyFlagGiven = mutationFlags.some((flag) =>
    flag !== "--session-model" && argv.includes(flag)
  );
  if (sessionModel !== undefined && !policyFlagGiven) {
    const planned = kiroModelsPlan({
      setModel: sessionModel,
      preset: currentKiroPreset,
      fetchLevels: true,
      keepExistingEffort: false,
    });
    if ("error" in planned) {
      emitResult(planned.error, options);
      return null;
    }
    if (!planned.plan) {
      emitResult(success("session model left to first-run setup"), options);
      return null;
    }
    return { kiroOnly: planned.plan };
  }
  if (!hasMutationFlags && !configInputIsTty()) {
    emitResult(
      usage(
        "non-interactive model configuration requires a policy flag: --preset, --from, a group effort flag, --agent, --session-model, or --reset; --yes confirms but never chooses a policy",
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
  const fetchKiroLevels = sessionModel !== undefined || (configInputIsTty() && !options.yes);
  if (canonical(targetCurrentSettings) === canonical(targetNextSettings)) {
    // The recorded policy is already this, but the person's Kiro session may
    // not carry it yet (a new model, or an effort changed inside Kiro).
    if (kiroCli && (sessionModel !== undefined || currentKiroPreset)) {
      const planned = kiroModelsPlan({
        ...(sessionModel !== undefined ? { setModel: sessionModel } : {}),
        preset: currentKiroPreset,
        fetchLevels: fetchKiroLevels,
        keepExistingEffort: true,
      });
      if ("error" in planned) {
        emitResult(planned.error, options);
        return null;
      }
      if (planned.plan) return { kiroOnly: planned.plan };
    }
    emitResult(success("model policy unchanged"), options);
    return null;
  }
  const nextResolved = resolveAidlcSettingsWithOverride(
    projectDir,
    target,
    targetNextSettings,
  );
  const next = modelPolicyForHarness(nextResolved.models, harness);
  let kiroPlan: KiroSessionPlan | undefined;
  let kiroNote: string | undefined;
  if (kiroCli) {
    const nextKiroPreset = isKiroPreset(next?.preset) ? next.preset : null;
    const planned = kiroModelsPlan({
      ...(sessionModel !== undefined ? { setModel: sessionModel } : {}),
      preset: nextKiroPreset,
      fetchLevels: fetchKiroLevels,
      keepExistingEffort: nextKiroPreset === currentKiroPreset,
    });
    if ("error" in planned) {
      emitResult(planned.error, options);
      return null;
    }
    kiroPlan = planned.plan ?? undefined;
    kiroNote = planned.note;
  }
  let confirm: PendingConfirm | undefined;
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
    confirm = {
      question: "Apply model policy changes?",
      cancelled: "model policy change cancelled",
    };
  }
  const summary = modelSummaryLines(current, next, tiers, harness, projectDir);
  return {
    ...(kiroPlan ? { kiro: kiroPlan } : {}),
    ...(kiroNote ? { kiroNote } : {}),
    argv: modelsPipelineArgv(argv),
    context: {
      confirm,
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
    "--question-retention-days",
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
            switches: switchesOffLines(projectDir, process.env, "command"),
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
    // A bypass with no layer goes to the person's own file, and a clear with no
    // layer reaches every file that records it, as in an installed project.
    const bypassTargets = section === "flags" ? bypassSettingsTargets(argv, projectDir, projectDir) : null;
    const target = bypassTargets?.[0] ?? settingsTargetForMutation(argv, projectDir);
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
    const mutations = [
      mutation,
      ...(bypassTargets ?? []).slice(1).map((layer) => flagsMutationFor(argv, projectDir, projectDir, layer)),
    ];
    if (argv.includes("--dry-run")) {
      emitResult(success(`${section} settings plan`, {
        target,
        path,
        previous: currentFile,
        next: nextFile,
        ...(mutations.length > 1 ? { others: mutations.slice(1) } : {}),
      }), options);
      return true;
    }
    // Typed at a terminal, or a bypass or clear-bypass, it is done as typed;
    // a script still confirms with --yes.
    if (!options.yes && !configInputIsTty() && !(section === "flags" && bypassOnlyRequest(argv, mutation))) {
      emitResult(usage(
        `non-interactive ${section} mutation requires --yes; --yes confirms but never chooses`,
        configMutationRerun(section, argv),
      ), options);
      return true;
    }
    const notes: string[] = [];
    const operations: TransactionOperation[] = [];
    const actions: PlannedAction[] = [];
    const excludes = mutations
      .filter((change) => change.target !== "global")
      .map((change) => planProjectSettingsMutation(projectDir, change, operations, actions));
    if (operations.length > 0) executePlan({ schemaVersion: 1, root: projectDir, operations });
    afterProjectSettings(projectDir, mutations, () => {
      for (const change of mutations) {
        if (change.target === "global") executeGlobalSettingsMutation(change);
      }
    });
    for (const exclude of excludes) {
      const note = excludeLocalSettingsFromClone(exclude);
      if (note) notes.push(note);
    }
    for (const change of mutations) invalidateSettingsCache(change.path);
    const changes = settingsChangeLines(projectDir, mutations);
    // The lines above already name any other file that still records a
    // cleared switch.
    const switchLines = section === "flags"
      ? [...new Set(mutations.flatMap((change) =>
        recordSwitchChange(projectDir, change.target, change.previous, change.next, { otherFiles: false })
      ))]
      : [];
    if (options.mode === "human") {
      writeMenuLines("", changes.map((line) => `  ${line}`));
      writeMenuLines("", notes.map((note) => `  Note: ${note}`));
      writeMenuLines("", switchLines);
    }
    emitResult(success(
      `configured ${section} settings in ${path}`,
      {
        target,
        path,
        changes,
        ...(notes.length > 0 ? { notes } : {}),
        ...(switchLines.length > 0 ? { switches: switchLines } : {}),
      },
    ), options);
  } catch (error) {
    emitResult(usage(
      error instanceof Error ? error.message : String(error),
      configCommand(`${section} --help`),
    ), options);
  }
  return true;
}

// No project file carries a bypass: every guard reads it from its settings
// file each time it checks. So a flags change that only adds or removes
// bypasses writes that file and refreshes nothing, and a running workflow does
// not hold it back. That is when a person needs a bypass, to end a refusal.
function changesOnlyBypasses(mutation: SettingsMutation | undefined): mutation is SettingsMutation {
  if (!mutation) return false;
  // `$schema` is editor metadata, so a file that keeps or drops it changes nothing.
  const withoutBypasses = (file: AidlcSettingsFile | null): string => {
    const { flags, $schema: _schema, ...rest } = file ?? { schemaVersion: 1 };
    const { bypasses: _bypasses, ...otherFlags } = flags ?? { schemaVersion: 1 };
    return canonical({ ...rest, flags: otherFlags });
  };
  return withoutBypasses(mutation.previous) === withoutBypasses(mutation.next);
}

// The one test for "record this bypass change and refresh nothing". --download
// asks for the release this project needs as well, which only the full path
// fetches.
function bypassOnlyRequest(
  argv: readonly string[],
  mutation: SettingsMutation | undefined,
): mutation is SettingsMutation {
  return !argv.includes("--download") && changesOnlyBypasses(mutation);
}

// One recorded setting, how it is printed, and the flags that set it. `value`
// is what changes are compared on; `shown` is what the person reads.
type SettingLeaf = {
  section: "flags" | "models";
  label: string;
  value: string;
  shown: string;
  args: string[];
};

const FLAG_LEAVES: ReadonlyArray<{
  key: "defaultScope" | "swarm" | "hookDebug" | "sensorTimeoutMs" | "questionRetentionDays";
  label: string;
  flag: string;
}> = [
  { key: "defaultScope", label: "default scope", flag: "--default-scope" },
  { key: "swarm", label: "swarm", flag: "--swarm" },
  { key: "hookDebug", label: "hook debug", flag: "--hook-debug" },
  { key: "sensorTimeoutMs", label: "sensor timeout (ms)", flag: "--sensor-timeout-ms" },
  { key: "questionRetentionDays", label: "question retention (days)", flag: "--question-retention-days" },
];

// A committed value as printed: one line, with every control, format, and
// line or paragraph separator character shown as "?".
function shownValue(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?");
}

// An undo is printed only when every argument prints as it is, so the command
// shown is the one that puts the value back.
function printableArgs(args: readonly string[]): boolean {
  return args.every((arg) => shownValue(arg) === arg);
}

const UNPRINTABLE_UNDO = "Its earlier value cannot be shown safely, so no undo command is shown.";

// A model ID is free text in a committed file, so it is printed only in the
// shape model IDs take; any other text is not shown, so it never reads as the
// tool's own words.
const SHOWN_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,199}$/;

/**
 * Every setting a settings file records apart from bypasses, keyed by where it
 * lives. `args` is empty when no one command sets the value back by itself.
 */
function settingLeaves(file: AidlcSettingsFile | null): Map<string, SettingLeaf> {
  const leaves = new Map<string, SettingLeaf>();
  const flags = file?.flags;
  for (const { key, label, flag } of FLAG_LEAVES) {
    const raw = flags?.[key];
    if (raw === undefined) continue;
    const value = typeof raw === "boolean" ? (raw ? "on" : "off") : String(raw);
    leaves.set(`flags.${key}`, { section: "flags", label, value, shown: value, args: [flag, value] });
  }
  const models = file?.models;
  if (models?.preset !== undefined) {
    leaves.set("models.preset", {
      section: "models",
      label: "model preset",
      value: models.preset,
      shown: models.preset,
      args: ["--preset", models.preset],
    });
  }
  for (const [group, policy] of Object.entries(models?.groups ?? {})) {
    if (!policy?.effort) continue;
    leaves.set(`models.groups.${group}`, {
      section: "models",
      label: `${MODEL_GROUPS[group as ModelGroup]?.label ?? group} effort`,
      value: policy.effort,
      shown: policy.effort,
      args: [`--${group}-effort`, policy.effort],
    });
  }
  for (const [agent, policy] of Object.entries(models?.agents ?? {})) {
    if (policy.effort) {
      leaves.set(`models.agents.${agent}.effort`, {
        section: "models",
        label: `${agent} effort`,
        value: policy.effort,
        shown: policy.effort,
        args: ["--agent", agent, "--effort", policy.effort],
      });
    }
    for (const [harness, model] of Object.entries(policy.model ?? {})) {
      if (!model) continue;
      // The model comes back with the agent's effort when one is recorded,
      // and on its own when none is.
      const shown = SHOWN_MODEL_ID.test(model);
      leaves.set(`models.agents.${agent}.model.${harness}`, {
        section: "models",
        label: `${agent} model (${harness})`,
        value: model,
        shown: shown ? model : "(a model ID that is not shown)",
        args: !shown
          ? []
          : policy.effort
          ? ["--agent", agent, "--effort", policy.effort, "--model", model, "--harness", harness]
          : ["--agent", agent, "--model", model, "--harness", harness],
      });
    }
  }
  // A saved profile changes nothing until --from loads it, and no one command
  // puts an earlier one back, so it is named with no undo of its own.
  for (const [name, profile] of Object.entries(models?.profiles ?? {})) {
    const groups = Object.entries(profile?.groups ?? {})
      .filter(([, policy]) => policy?.effort)
      .map(([group, policy]) => `${group} ${policy?.effort}`)
      .sort();
    const value = groups.length > 0 ? groups.join(", ") : "empty";
    leaves.set(`models.profiles.${name}`, { section: "models", label: `model profile ${name}`, value, shown: value, args: [] });
  }
  return leaves;
}

// What a settings change did, one line each, with the command that undoes it.
// A setting that was not there before has no flag that removes it, so its undo
// is the section's --reset, offered only when that resets nothing else the
// file records; otherwise the line says it was not set there before.
function settingsChangeLines(
  projectDir: string,
  mutations: readonly SettingsMutation[],
  harness?: string,
): string[] {
  const fileOf = (target: SettingsTarget): string => {
    const path = settingsPathForTarget(projectDir, target);
    return target === "global" ? path : relative(projectDir, path);
  };
  const command = (section: "flags" | "models", args: string[], target: SettingsTarget): string =>
    `${configInvocationFor(projectDir)} config ${section} ${
      args.map((arg) => quoteCommandArgument(arg)).join(" ")
    } --${target} --yes${namedHarness(projectDir, harness)}${projectTarget(projectDir)}`;
  const lines: string[] = [];
  for (const change of mutations) {
    const file = fileOf(change.target);
    const before = new Set(change.previous?.flags?.bypasses ?? []);
    const after = new Set(change.next?.flags?.bypasses ?? []);
    for (const name of after) {
      if (!before.has(name)) {
        lines.push(`Recorded ${name} in ${file}. To undo: ${command("flags", ["--clear-bypass", name], change.target)}`);
      }
    }
    for (const name of before) {
      if (!after.has(name)) {
        lines.push(`Cleared ${name} from ${file}. To undo: ${command("flags", ["--bypass", name], change.target)}`);
      }
    }
    const was = settingLeaves(change.previous);
    const now = settingLeaves(change.next);
    for (const section of ["flags", "models"] as const) {
      const ids = [...new Set([...was.keys(), ...now.keys()])]
        .filter((id) => id.startsWith(`${section}.`) && was.get(id)?.value !== now.get(id)?.value)
        .sort();
      if (ids.length === 0) continue;
      // --reset removes the whole section, so it is the undo only when the
      // file had none of it before (saved profiles included) and, for flags,
      // it would not also clear a bypass.
      const before = change.previous?.[section];
      const sectionWasEmpty = !before || Object.keys(before).every((key) => key === "schemaVersion");
      const resetUndoes = sectionWasEmpty && (section === "models" || after.size === 0);
      if (resetUndoes) {
        lines.push(
          `Recorded ${ids.map((id) => shownValue(`${now.get(id)?.label} ${now.get(id)?.shown}`)).join(", ")} in ${file}. To undo: ${
            command(section, ["--reset"], change.target)
          }`,
        );
        continue;
      }
      for (const id of ids) {
        const old = was.get(id);
        const fresh = now.get(id);
        const label = old?.label ?? fresh?.label ?? id;
        const undo = old && old.args.length > 0
          ? printableArgs(old.args) ? ` To undo: ${command(section, old.args, change.target)}` : ` ${UNPRINTABLE_UNDO}`
          : old && old.shown !== old.value
          ? ` ${UNPRINTABLE_UNDO}`
          : old
          ? ""
          : id === "flags.questionRetentionDays"
          ? ` To undo: ${command(section, ["--question-retention-days", "unlimited"], change.target)}`
          : " It was not set there before.";
        lines.push(shownValue(`${label}: ${old?.shown ?? "not set"} -> ${fresh?.shown ?? "not set"} in ${file}.${undo}`));
      }
    }
  }
  // A clear aimed at one layer leaves the switch on where another records it:
  // say so, with the command that clears it there.
  const cleared = mutations.flatMap((change) => {
    const after = new Set(change.next?.flags?.bypasses ?? []);
    return (change.previous?.flags?.bypasses ?? []).filter((name) => !after.has(name));
  });
  for (const name of new Set(cleared)) {
    for (const layer of layersRecordingBypass(projectDir, name)) {
      lines.push(
        `${name} is still recorded in ${fileOf(layer)}, so it stays on. To clear it there: ${
          command("flags", ["--clear-bypass", name], layer)
        }`,
      );
    }
  }
  return lines;
}

// What a harness.json answer changed, with the command that puts the earlier
// one back where a command can.
function recordChangeLines(projectDir: string, context: DiagnosticsMutationContext): string[] {
  if (canonical(context.previous) === canonical(context.next)) return [];
  const file = `${context.harnessDir}/tools/data/harness.json`;
  const command = (args: string[]): string =>
    `${configInvocationFor(projectDir)} config ${context.section} ${
      args.map((arg) => quoteCommandArgument(arg)).join(" ")
    } --yes${namedHarness(projectDir, context.harness)}${projectTarget(projectDir)}`;
  if (context.previous === null) {
    return [`Recorded the ${context.section} answer in ${file}. To undo: ${command(["--reset"])}`];
  }
  if (context.section === "providers") {
    const earlier = context.previous as ProvidersRecord;
    if (earlier.provider) {
      const args = [
        "--provider",
        earlier.provider === "builtin" ? "current" : earlier.provider,
        ...(earlier.region ? ["--region", earlier.region] : []),
        ...(earlier.profile ? ["--profile", earlier.profile] : []),
        ...(earlier.opencodeDefault === undefined ? [] : ["--opencode-default", earlier.opencodeDefault ? "yes" : "no"]),
        ...(earlier.acknowledged ? ["--acknowledge"] : []),
        ...(earlier.pendingActions ?? []).filter((item) => item.status === "done").flatMap((item) => ["--mark-done", item.id]),
      ];
      return [`Changed the providers answer in ${file}. ${
        printableArgs(args) ? `To undo: ${command(args)}` : UNPRINTABLE_UNDO
      }`];
    }
  }
  if (context.next === null && context.section === "trust") {
    // --acknowledge records a review, so it is the undo only when one was
    // recorded before.
    return (context.previous as TrustRecord).reviewed === true
      ? [`Cleared the trust answer in ${file}. To undo: ${command(["--acknowledge"])}`]
      : [`Cleared the trust answer in ${file}.`];
  }
  if (context.next === null && context.section === "runtime") {
    return [`Cleared the recorded runtime paths in ${file}. To record them again: ${command(["--record-paths"])}`];
  }
  return [`Changed the ${context.section} answer in ${file}.`];
}

// Who picks a recorded setting up, said once after it is written. A guard
// reads its bypass at every check, and each hook or tool run reads hook debug,
// the sensor timeout, and question retention, so those apply right away, a
// retry in the same step included. Models and swarm apply from the next step,
// a default scope to new work, and a saved profile changes nothing until
// --from loads it.
const RIGHT_AWAY_FLAGS = new Map([
  ["flags.hookDebug", "hook debug"],
  ["flags.sensorTimeoutMs", "the sensor timeout"],
  ["flags.questionRetentionDays", "question retention"],
]);

// `nextSession` names a tool that reads the change only when a session starts.
function openWorkflowLine(
  projectDir: string,
  mutations: readonly SettingsMutation[],
  nextSession?: string,
): string | null {
  const open = activeWorkflowDescriptions(projectDir);
  const [first, ...rest] = mutations;
  if (open.length === 0 || !first) return null;
  const who = `${open.length} open workflow${open.length === 1 ? "" : "s"} (${open.join(", ")})`;
  const verb = (word: string): string => `${word}${open.length === 1 ? "s" : ""}`;
  // Open work reads every settings file together, so the line compares the
  // settings it reads before and after; a change another file outranks
  // reaches nothing.
  const effective = (side: "previous" | "next") =>
    resolveAidlcSettingsWithOverride(
      projectDir,
      first.target,
      first[side],
      rest.map((change) => ({ target: change.target, next: change[side] })),
    ).value;
  const before = effective("previous");
  const after = effective("next");
  const was = settingLeaves(before);
  const now = settingLeaves(after);
  const changed = [...new Set([...was.keys(), ...now.keys()])]
    .filter((id) => !id.startsWith("models.profiles.") && was.get(id)?.value !== now.get(id)?.value);
  const bypasses = (file: AidlcSettingsFile | null | undefined): string =>
    canonical([...(file?.flags?.bypasses ?? [])].sort());
  const switched = bypasses(before) !== bypasses(after);
  const rightAway = [
    ...(switched ? ["the switch"] : []),
    ...changed.flatMap((id) => RIGHT_AWAY_FLAGS.get(id) ?? []),
  ];
  const nextStep = changed.some((id) => id !== "flags.defaultScope" && !RIGHT_AWAY_FLAGS.has(id));
  const from = nextSession ? `from your next ${nextSession} session` : "from the next step";
  const later = nextSession
    ? `the ${nextSession} session already running keeps what it started with`
    : "a step already running keeps what it started with";
  const scopeNote = changed.includes("flags.defaultScope") ? "; the default scope applies to new work only" : "";
  if (rightAway.length > 0 && nextStep) {
    const named = rightAway.length === 1
      ? rightAway[0]
      : `${rightAway.slice(0, -1).join(", ")} and ${rightAway[rightAway.length - 1]}`;
    return `${who} ${verb("pick")} up ${named} right away, with no restart, and the other settings ${from}; ${later}${scopeNote}.`;
  }
  if (rightAway.length > 0) return `${who} ${verb("pick")} this up right away, with no restart${scopeNote}.`;
  if (nextStep) return `${who} ${verb("pick")} this up ${from}; ${later}${scopeNote}.`;
  if (scopeNote) return `The default scope applies to new work; ${who} ${verb("keep")} the scope it started with.`;
  // The file changed, but what open work reads did not: another file sets the
  // same thing, or outranks it. A saved profile reaches nothing either.
  const reached = (file: AidlcSettingsFile | null, part: "flags" | "models"): string => {
    if (part === "flags") return canonical(file?.flags ?? null);
    const { profiles: _profiles, ...models } = file?.models ?? {};
    return canonical(models);
  };
  const outranked = (["flags", "models"] as const).find((part) =>
    mutations.some((change) => reached(change.previous, part) !== reached(change.next, part))
  );
  return outranked
    ? `${who} ${verb("run")} as before, because the settings ${open.length === 1 ? "it reads" : "they read"} did not change (\`${configInvocationFor(projectDir)} config ${outranked} --show${projectTarget(projectDir)}\` shows which file sets each).`
    : null;
}

// A refresh that brings in release files is done while work is open too: one
// line says so, and when it moved the project to another release, how to go
// back. Natively a pin brings the earlier release back; a copied project takes
// that release's files again. A harness added beside open work has no command
// that removes it, so its line names the folder it added. A switch is undone
// by switching back, which the summary line already names, so it has no
// release line.
function refreshDoneLines(
  projectDir: string,
  change: {
    added?: string;
    switched: boolean;
    from?: string;
    to: string;
    pinned: boolean;
    copyChannel: boolean;
    releaseBaseUrl?: string;
    harness: string;
    // Open work that needs a plugin this change turned off, by plugin.
    pluginsOff: ReadonlyArray<{ plugin: string; workflow: string }>;
  },
): string[] {
  const open = activeWorkflowDescriptions(projectDir);
  if (open.length === 0) return [];
  const listed = (items: readonly string[]): string =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const stopped = [...new Set(change.pluginsOff.map((item) => item.workflow))].sort();
  const plugins = [...new Set(change.pluginsOff.map((item) => item.plugin))].sort();
  const going = open.filter((name) => !stopped.includes(name));
  const carriesOn = stopped.length === 0
    ? `Your open work (${open.join(", ")}) carries on.`
    : `${going.length > 0 ? `Your open work (${going.join(", ")}) carries on. ` : ""}${stopped.join(", ")} ${
      stopped.length === 1 ? "needs" : "need"
    } the ${listed(plugins)} plugin${plugins.length === 1 ? "" : "s"}, which ${plugins.length === 1 ? "is" : "are"} now off, so ${
      stopped.length === 1 ? "it continues" : "they continue"
    } once ${plugins.length === 1 ? "it is" : "they are"} on again.`;
  if (change.added) return [`Added ${change.added}. ${carriesOn}`];
  if (change.switched) return [`Updated. ${carriesOn}`];
  // The earlier version is read from the project's committed manifest, so it
  // is printed only when it is a release id.
  if (!change.from || change.from === change.to || !VERSION_ID.test(change.from)) return [`Updated. ${carriesOn}`];
  const command = (args: string): string => `\`${configInvocationFor(projectDir)} config ${args}${projectTarget(projectDir)}\``;
  return [
    `Updated. ${carriesOn}`,
    change.copyChannel
      ? `To go back: get ${copyRuntimeUrl(change.from, change.releaseBaseUrl)} and its .sha256 into one folder, then run ${
        command(`--from <that file> --yes${namedHarness(projectDir, change.harness)}`)
      }.`
      : change.pinned
      ? `To go back: ${command(`--pin ${quoteCommandArgument(change.from)} --yes`)}.`
      : `To go back: ${command(`--pin ${quoteCommandArgument(change.from)} --yes`)} (this pins the version for everyone on the project; ${
        command("--unpin")
      } removes the pin).`,
  ];
}

// A run that wrote one harness tree from a release names every other tree in
// the project on another release, with the command that brings it to the
// release just written: the plain command when it takes that release, else the
// same --from files when they hold that harness. Otherwise a copied project
// gets the copy runtime first (a copied tree's --download fetches its own
// release), and a native one the pin that installs that release; a pinned
// release without that harness has no command to name.
function treesLeftBehindLines(
  projectDir: string,
  written: { distribution: string; harnessDir: string; version: string },
  source: {
    from?: string;
    holds?: readonly string[];
    requiredVersion?: string;
    copyChannel: boolean;
    releaseBaseUrl?: string;
  },
): string[] {
  if (!VERSION_ID.test(written.version)) return [];
  const behind = discoverProjectHarnesses(projectDir).filter((tree) =>
    tree.distribution !== written.distribution && tree.frameworkVersion !== written.version
  );
  if (behind.length === 0) return [];
  // The run is already done, so a source that cannot be listed only means no
  // plain command is named.
  let installed: InstalledSourceCandidate[];
  try {
    installed = installedSourceCandidates(source.requiredVersion);
  } catch {
    installed = [];
  }
  // A copied project runs the written tree's own tool: it is on that release,
  // and an older tool may not read its files.
  const tool = source.copyChannel
    ? `bun ${
      quoteCommandArgument(
        ranFromProject(projectDir)
          ? `${written.harnessDir}/tools/aidlc.ts`
          : join(projectDir, written.harnessDir, "tools", "aidlc.ts"),
      )
    }`
    : configInvocationFor(projectDir);
  const command = (args: string): string => `\`${tool} config ${args}${projectTarget(projectDir)}\``;
  return behind.map((tree) => {
    const name = `${projectionProductName(tree.root, tree.distribution)} (${tree.harnessDir})`;
    const on = tree.frameworkVersion === undefined
      ? "is still on an earlier aidlc that did not record its version"
      : predatesFrameworkVersion(tree.frameworkVersion, written.version)
      ? `is still on ${tree.frameworkVersion}`
      : `is on ${tree.frameworkVersion}`;
    const harness = `--harness ${tree.distribution}`;
    const plain = installed.filter((candidate) => candidate.stamp.distribution === tree.distribution);
    // A copied tree no config run has recorded the files of reads every file
    // as unowned against another release, so it first records them at its
    // own, as doctor's row says.
    const record = source.copyChannel && !existsSync(join(tree.root, "tools", "data", "aidlc-manifest.json"))
      ? `${command(`${harness} --download`)}, then `
      : "";
    const step = plain.length === 1 && plain[0].stamp.frameworkVersion === written.version
      ? `${record}${command(harness)}`
      : source.from && source.holds?.includes(tree.distribution) && printableArgs([source.from])
      ? `${record}${command(`${harness} --from ${quoteCommandArgument(source.from)}`)}`
      : source.copyChannel
      ? `get ${copyRuntimeUrl(written.version, source.releaseBaseUrl)} and its .sha256 into one folder, then run ${record}${
        command(`${harness} --from <that file>`)
      }`
      : source.requiredVersion === undefined
      ? `${command(`--pin ${quoteCommandArgument(written.version)} --yes`)} (this pins the version for everyone on the project), then ${
        command(harness)
      }`
      : null;
    return step ? `${name} ${on}. To bring it to ${written.version}: ${step}.` : `${name} ${on}.`;
  });
}

// What a project choice changed, with the command that puts the earlier one
// back when one command can say it exactly.
function projectChangeLines(projectDir: string, context: ChoicesMutationContext): string[] {
  const before = context.previous as ProjectChoicesRecord | null;
  const after = context.next as ProjectChoicesRecord | null;
  const pluginsChanged = canonical(context.previousPlugins) !== canonical(context.nextPlugins);
  if (canonical(before) === canonical(after) && !pluginsChanged) return [];
  const file = `${context.harnessDir}/tools/data/harness.json`;
  let undo: string[] | null = [];
  if (before === null && context.previousPlugins === null) {
    undo = ["--reset"];
  } else {
    if (pluginsChanged) {
      undo = context.previousPlugins === null
        ? ["--plugins", "all"]
        : context.previousPlugins.length > 0
        ? ["--plugins", context.previousPlugins.join(",")]
        : null;
    }
    for (const [key, flag] of [["mcp", "--mcp"], ["completions", "--completions"]] as const) {
      if (!undo || before?.[key] === after?.[key]) continue;
      const earlier = before?.[key];
      undo = earlier ? [...undo, flag, earlier] : null;
    }
  }
  if (!undo || !printableArgs(undo)) return [`Changed the project choices in ${file}.`];
  return [`Changed the project choices in ${file}. To undo: ${configInvocationFor(projectDir)} config project ${
    undo.map((arg) => quoteCommandArgument(arg)).join(" ")
  } --yes${namedHarness(projectDir, context.distribution)}${projectTarget(projectDir)}`];
}

// The machine settings file lives outside the project, so its change runs as
// its own step after the project's. When that step fails, the project files
// have already changed: the error says which, and rerunning the same command
// finishes the rest.
function afterProjectSettings(
  projectDir: string,
  changed: readonly SettingsMutation[],
  machineStep: () => void,
): void {
  try {
    machineStep();
  } catch (error) {
    const files = changed
      .filter((change) => change.target !== "global" && canonical(change.previous) !== canonical(change.next))
      .map((change) => relative(projectDir, change.path));
    if (files.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${files.join(" and ")} changed, but the machine settings file did not: ${reason}. Run the same command again to finish.`,
    );
  }
}

function recordBypassesOnly(
  projectDir: string,
  argv: readonly string[],
  context: ChoicesMutationContext,
  mutation: SettingsMutation,
  options: ReturnType<typeof globalOptions>,
  setupWalkChild: boolean,
): void {
  try {
    // A no-layer clear changes every layer that records the bypass.
    const mutations = [mutation, ...(context.extraSettings ?? [])];
    const operations: TransactionOperation[] = [];
    const machineOperations: TransactionOperation[] = [];
    const actions: PlannedAction[] = [];
    const excludes: Array<string | null> = [];
    for (const change of mutations) {
      excludes.push(planProjectSettingsMutation(projectDir, change, operations, actions));
      const machine = globalSettingsOperation(change);
      if (!machine) continue;
      machineOperations.push(machine);
      actions.push({
        path: change.path,
        action: change.next === null
          ? "remove"
          : pathPresent(change.path)
          ? "update"
          : "create",
      });
    }
    const counts = Object.fromEntries(
      ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
        name,
        actions.filter((item) => item.action === name).length,
      ]),
    );
    const planToken = sha256Bytes(canonical({
      schemaVersion: 1,
      root: projectDir,
      operations,
      ...(machineOperations.length > 0
        ? {
            externalSettings: {
              root: machineTransactionRoot(),
              operations: machineOperations,
            },
          }
        : {}),
    }));
    const choices = {
      section: context.section,
      previous: context.previous,
      next: context.next,
      previousPlugins: context.previousPlugins,
      nextPlugins: context.nextPlugins,
      summaries: context.summaryLines,
      notes: context.notes,
    };
    if (argv.includes("--dry-run")) {
      if (options.mode === "human") {
        for (const line of context.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of context.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      emitResult(success(
        `flags configuration plan for ${projectDir}: ${
          Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")
        }`,
        {
          projectDir,
          ...(context.anyHarness ? {} : { distribution: context.distribution }),
          counts,
          actions,
          planToken,
          notes: [],
          choices,
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
    // Run the operations the plan token covers, so a settings file that
    // changed since they were planned is a conflict, not overwritten.
    if (operations.length > 0) executePlan({ schemaVersion: 1, root: projectDir, operations });
    if (machineOperations.length > 0) {
      afterProjectSettings(projectDir, operations.length > 0 ? mutations : [], () =>
        executePlan({ schemaVersion: 1, root: machineTransactionRoot(), operations: machineOperations })
      );
    }
    const notes = excludes.flatMap((exclude) => excludeLocalSettingsFromClone(exclude) ?? []);
    for (const change of mutations) invalidateSettingsCache(change.path);
    // What changed, the command that undoes it, and who picks it up.
    const changes = settingsChangeLines(projectDir, mutations);
    const open = openWorkflowLine(projectDir, mutations);
    if (open) changes.push(open);
    // Which of the person's checks is now off or back on, in plain words.
    // The lines above already name any other file that still records a
    // cleared switch.
    const switchLines = [...new Set(mutations.flatMap((change) =>
      recordSwitchChange(projectDir, change.target, change.previous, change.next, { otherFiles: false })
    ))];
    // With several harnesses and none named, no one harness's setup is the
    // person's to finish here.
    const outstandingActions = setupWalkChild || context.anyHarness
      ? []
      : postApplyOutstandingActions(projectDir, context.harnessDir, context.harness);
    if (options.mode === "human") {
      // The person sees what changed with its undo, and which check is now
      // off or on again; anything more only when something still needs them.
      writeMenuLines("", changes);
      writeMenuLines("", notes.map((note) => `Note: ${note}`));
      writeMenuLines("", switchLines);
      if (changes.length + notes.length + switchLines.length === 0) {
        writeMenuLines("", [`configured flags settings for ${projectDir}`]);
      }
      if (outstandingActions.length > 0) {
        process.stdout.write(`${menuText(configCompletionMessage("", outstandingActions, "human").trimStart())}\n`);
      }
      process.exitCode = EXIT.ok;
      return;
    }
    const completion = configCompletionMessage(
      `configured flags settings for ${projectDir}`,
      outstandingActions,
      options.mode,
    );
    emitResult(success(
      completion,
      {
        projectDir,
        ...(context.anyHarness ? {} : { distribution: context.distribution }),
        counts,
        actions,
        planToken,
        notes,
        changes,
        outstandingActions,
        choices,
        ...(switchLines.length > 0 ? { switches: switchLines } : {}),
      },
    ), options);
  } catch (error) {
    emitResult(failure(
      error instanceof Error ? error.message : String(error),
      EXIT.integrity,
      error instanceof TransactionFilesystemError ? error.remediation : undefined,
    ), options);
  }
}

// `config --show [--json]`: each section's own `--show`, in CONFIG_SECTIONS
// order, run in this process with its output gathered, so every block is
// exactly what that section prints. A section that cannot answer here (no
// installed harness yet) answers with its own message, and the read still
// succeeds: agents run this first for "show my settings".
async function showEverySection(
  argv: readonly string[],
  options: ReturnType<typeof globalOptions>,
  internal: ConfigMainInternal,
): Promise<void> {
  const projectDir = valueAfter(argv, "--project-dir");
  const shared = [
    ...(projectDir === undefined ? [] : ["--project-dir", projectDir]),
    ...(argv.includes("--no-color") ? ["--no-color"] : []),
    ...(options.mode === "json" ? ["--json"] : []),
  ];
  const answers: Array<{ section: string; stdout: string; output: string; code: number }> = [];
  for (const section of CONFIG_SECTIONS) {
    answers.push({ section, ...(await gatherConfigOutput([section, "--show", ...shared], internal)) });
  }
  if (options.mode === "json") {
    const sections = Object.fromEntries(answers.map(({ section, stdout, code }) => {
      try {
        return [section, JSON.parse(stdout) as unknown];
      } catch {
        return [section, { ok: false, code, status: "failed", message: stdout.trim() }];
      }
    }));
    emitResult(success("settings for every config section", { sections }), options);
    return;
  }
  process.stdout.write(
    answers.map(({ section, output }) => `${heading(section, process.stdout)}\n${output.replace(/\n*$/, "\n")}`)
      .join("\n"),
  );
  process.exitCode = EXIT.ok;
}

// Runs one config command in this process and hands back what it printed
// (stdout alone, and both streams in order) and its exit code, leaving the
// caller's exit code as it was.
async function gatherConfigOutput(
  args: string[],
  internal: ConfigMainInternal,
): Promise<{ stdout: string; output: string; code: number }> {
  const stdout: string[] = [];
  const output: string[] = [];
  const text = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
  const gather = (toStdout: boolean) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      if (toStdout) stdout.push(text(chunk));
      output.push(text(chunk));
      const done = rest.find((item) => typeof item === "function") as (() => void) | undefined;
      done?.();
      return true;
    }) as typeof process.stdout.write;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = gather(true);
  process.stderr.write = gather(false);
  try {
    await main(args, internal);
  } catch (error) {
    output.push(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  const code = typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
  process.exitCode = exitCode;
  return { stdout: stdout.join(""), output: output.join(""), code };
}

export async function main(
  input: string[],
  internal: ConfigMainInternal = {},
): Promise<void> {
  // A setup walk's own sections run inside the walk, for the harness it set up.
  if (!internal.setupWalkChild) configTargetHarnessDir = null;
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
    if (argv.includes("--show") && !argv.includes("--help")) {
      await showEverySection(argv, options, internal);
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
  let pendingKiroSession: KiroSessionPlan | null = null;
  let diagnosticsContext: DiagnosticsMutationContext | null = null;
  let choicesContext: ChoicesMutationContext | null = null;
  if (section?.value === "models") {
    argv = [...argv.slice(0, section.index), ...argv.slice(section.index + 1)];
    try {
      const preparedModels = prepareModelsSection(argv, options);
      if (!preparedModels) return;
      if ("kiroOnly" in preparedModels) {
        await emitKiroSessionResult(
          await applyKiroSessionPlan({
            ...preparedModels.kiroOnly,
            dryRun: argv.includes("--dry-run"),
          }),
          options,
        );
        return;
      }
      argv = preparedModels.argv;
      modelsContext = preparedModels.context;
      pendingKiroSession = preparedModels.kiro ?? null;
      if (preparedModels.kiroNote) modelsContext.notes.push(preparedModels.kiroNote);
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
  if (
    choicesContext?.section === "flags" &&
    bypassOnlyRequest(argv, choicesContext.settings)
  ) {
    recordBypassesOnly(
      projectDirFrom(argv),
      argv,
      choicesContext,
      choicesContext.settings,
      options,
      Boolean(internal.setupWalkChild),
    );
    return;
  }
  if (argv.includes("--channel")) {
    emitResult(configureChannel(argv), options);
    return;
  }
  if (argv.includes("--pin") || argv.includes("--unpin")) {
    emitResult(await configureProjectPin(argv, {
      activeWorkflows: activeWorkflowDescriptions,
      // A project with several harnesses refreshes each one by name.
      refreshCommands: (dir) => {
        const harnesses = discoverProjectHarnesses(dir).map((harness) => harness.distribution).sort();
        return harnesses.length > 1
          ? harnesses.map((name) => `${configInvocationFor(dir)} config --harness ${name}${projectTarget(dir)}`)
          : [`${configInvocationFor(dir)} config${projectTarget(dir)}`];
      },
    }), options);
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
        "--download",
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
        "--download",
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
    process.stdout.write("\n");
    writeMenuRow(
      "  ",
      `Found ${installed.distribution} in ${installed.harnessDir}/; using the existing copied projection.`,
    );
    const outstanding = existingProjectionOutstanding(projectDir, installed);
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
  let prepared: PreparedRefreshSource | null = null;
  // The release this run found missing, the download it fetched, and what it
  // tells the user about where the source came from.
  let activeNeed: ReleaseNeed | null = null;
  let downloadCleanup: string | undefined;
  let ownFilesProject = false;
  let acquiring = false;
  let releaseHold: (() => void) | null = null;
  const sourceNotes: string[] = [];
  try {
    const existing = existingProject(projectDir, requestedHarness);
    // A switch that cannot proceed is refused before any release is fetched
    // for it; it runs again once the source is selected, just before planning.
    const switchOccupant = !existing.distribution && requestedHarness
      ? projectHarnesses.find((candidate) =>
        candidate.harnessDir === KIRO_SWITCH_DIR && switchesInPlace(candidate.distribution, requestedHarness)
      )
      : undefined;
    if (switchOccupant && requestedHarness) {
      // The same order as the checks after source selection.
      assertHooksDirReviewable(projectDir, `${switchOccupant.harnessDir}/hooks`, switchOccupant.harnessDir, requestedHarness);
      assertSwitchBaseline(switchOccupant, requestedHarness);
    }
    const pinPath = join(projectDir, ".aidlc-version");
    if (pathPresent(pinPath) && !regularFile(pinPath)) {
      throw new Error("project pin .aidlc-version is not a regular file");
    }
    const requiredVersion = regularFile(pinPath) ? readFileSync(pinPath, "utf-8").trim() : undefined;
    // As in the dispatcher, a pin is one release id: no other text of a
    // committed file may reach a message or a command this prints.
    if (requiredVersion !== undefined && !VERSION_ID.test(requiredVersion)) {
      emitResult(usage(
        `${pinPath} must contain one release version id`,
        configCommand(`--unpin${projectTarget(projectDir)}`),
      ), options);
      return;
    }
    const recordSection = Boolean(
      modelsContext ||
      diagnosticsContext ||
      choicesContext?.section === "flags",
    );
    let recordOnly = recordSection;
    const copyChannel = aidlcInvocation() !== "aidlc";
    const dryRun = argv.includes("--dry-run");
    const releaseSettings = {
      baseUrl: valueAfter(argv, "--release-base-url"),
      caBundle: valueAfter(argv, "--ca-bundle"),
    };
    const pendingConfirm = modelsContext?.confirm ??
      diagnosticsContext?.confirm ??
      choicesContext?.confirm;
    let need: ReleaseNeed | null = null;
    // What this run will also do before the change itself, said in the
    // question and done only once it is answered.
    let registerPin: { version: string; distribution: string } | null = null;
    let updateFirst: string | null = null;
    // Natively a pin names a retained engine that must also be registered for
    // this project. An installed release only needs registering; a missing one
    // needs the download.
    const pinnedDistribution = existing.distribution ?? requestedHarness;
    if (!copyChannel && requiredVersion !== undefined && !from && pinnedDistribution) {
      if (resolvePinnedDispatch([], projectDir).kind === "failure") {
        // An explicit runtime root can supply the bytes without the version
        // store holding them; only a stored release can be registered.
        const stored = pinnedReleaseInstalled(requiredVersion, pinnedDistribution);
        const available = stored ||
          installedSourceCandidates(requiredVersion).some((candidate) =>
            candidate.stamp.distribution === pinnedDistribution
          );
        if (!available) {
          need = { cause: "pin-missing", version: requiredVersion, distribution: pinnedDistribution };
        } else if (stored && !dryRun) {
          registerPin = { version: requiredVersion, distribution: pinnedDistribution };
          releaseHold = holdPinnedRelease(requiredVersion);
        }
      }
    }
    if (!need && recordSection && existing.distribution && !from) {
      const own = copiedProjectSource(projectDir, requestedHarness);
      if (requiredVersion === undefined || own.stamp.frameworkVersion === requiredVersion) {
        selected = own;
      } else {
        // A record-only section reads the project's own files, and they are not
        // the pinned release: update them first. Natively the pinned release is
        // already here, so that needs no consent beyond this command.
        if (own.cleanup) rmSync(own.cleanup, { recursive: true, force: true });
        const installedPinned = copyChannel
          ? []
          : installedSourceCandidates(requiredVersion).filter((candidate) =>
            candidate.stamp.distribution === own.stamp.distribution
          );
        // An explicit runtime root comes first, as it does for every source.
        if (installedPinned.length > 0) {
          selected = installedPinned[0];
          recordOnly = false;
          updateFirst = `${own.stamp.harnessDir} from ${own.stamp.frameworkVersion} to ${requiredVersion}, the pinned release (already installed)`;
          sourceNotes.push(`Updating ${updateFirst}.`);
        } else {
          need = {
            cause: "pin",
            version: requiredVersion,
            distribution: own.stamp.distribution,
            harnessDir: own.stamp.harnessDir,
            current: own.stamp.frameworkVersion,
          };
        }
      }
    } else if (!need) {
      try {
        selected = selectSource(
          requestedHarness,
          from,
          existing.distribution,
          requiredVersion,
        );
      } catch (error) {
        // Natively and unpinned, a missing harness means the active runtime
        // lacks it, which no download of this project's release repairs.
        if (
          !(error instanceof MissingInstalledSource) ||
          from ||
          (!copyChannel && requiredVersion === undefined)
        ) {
          throw error;
        }
        const harness = projectHarnesses.find((candidate) =>
          candidate.distribution === error.distribution
        );
        // A copied project changing its choices at the release it already has
        // uses its own files, unless MCP is being turned back on and its
        // shipped server list is gone. On its first run it trusts the copy,
        // as the record-only sections do: a verified release would cost every
        // new copy a download for the rare edit made before that run.
        if (
          copyChannel &&
          choicesContext?.section === "project" &&
          harness &&
          (requiredVersion === undefined || harness.frameworkVersion === requiredVersion)
        ) {
          const own = copiedProjectSource(projectDir, error.distribution);
          const previousMcp = normalizeProjectChoicesRecord(choicesContext?.previous)?.mcp;
          const mcpTarget = choicesContext?.mcpMode;
          if (
            ownFilesCoverChoices(
              projectDir,
              own.descriptor,
              mcpTarget !== previousMcp ? mcpTarget : undefined,
            )
          ) {
            selected = own;
            ownFilesProject = true;
          } else {
            if (own.cleanup) rmSync(own.cleanup, { recursive: true, force: true });
            need = {
              cause: "mcp",
              version: own.stamp.frameworkVersion,
              distribution: own.stamp.distribution,
              harnessDir: own.stamp.harnessDir,
              absent: !pathPresent(join(projectDir, ".mcp.json")),
            };
          }
        }
        if (!selected && !need) {
          need = {
            version: requiredVersion ?? harness?.frameworkVersion ??
              (switchOccupant?.frameworkVersion && VERSION_ID.test(switchOccupant.frameworkVersion)
                ? switchOccupant.frameworkVersion
                : undefined) ??
              AIDLC_VERSION,
            distribution: error.distribution,
            harnessDir: harness?.harnessDir ?? switchOccupant?.harnessDir,
            current: harness?.frameworkVersion,
            ...(switchOccupant ? { switchingFrom: switchOccupant.distribution } : {}),
            cause: !copyChannel
              ? "pin-missing"
              : !harness && switchOccupant
              ? "switch"
              : !harness
              ? "add"
              : requiredVersion !== undefined && harness.frameworkVersion !== requiredVersion
              ? "pin"
              : existsSync(memoryDirFor(projectDir, DEFAULT_SPACE))
              ? "refresh"
              : "restore",
          };
        }
      }
    }
    let askedConfirm = false;
    if (need) {
      activeNeed = need;
      const host = releaseHostLabel(releaseSettings.baseUrl);
      let approved = argv.includes("--download");
      if (!approved && !dryRun && options.mode === "human" && configInputIsTty() && !options.yes) {
        process.stdout.write(`${releaseNeedSentence(need)}\n`);
        if (pendingConfirm) {
          askedConfirm = true;
          const answer = configPrompt(
            `${pendingConfirm.question} ${releaseNeedDownload(need, host, "state")}. [y/N]:`,
          );
          approved = Boolean(answer && /^y(?:es)?$/i.test(answer.trim()));
        } else {
          const answer = configPrompt(`${releaseNeedDownload(need, host, "ask")}? [Y/n]:`);
          approved = answer !== null && /^(?:|y|yes)$/i.test(answer.trim());
        }
      }
      if (!approved) throw new NeedsRelease(need);
      if (!copyChannel) {
        if (dryRun) {
          emitResult(usage(
            `--dry-run does not install releases; install ${need.version} first with ${
              configCommand(`--pin ${need.version}${projectTarget(projectDir)}`)
            }`,
          ), options);
          return;
        }
        acquiring = true;
        releaseHold = holdPinnedRelease(need.version);
        await installPinnedRelease({
          projectDir,
          version: need.version,
          distribution: need.distribution,
          ...releaseSettings,
        });
        acquiring = false;
        sourceNotes.push(`Installed ${need.version}.`);
        registerPin = { version: need.version, distribution: need.distribution };
        selected = selectSource(requestedHarness, undefined, existing.distribution, requiredVersion);
      } else {
        acquiring = true;
        const fetched = await acquireCopyRuntime({
          version: need.version,
          distribution: need.distribution,
          ...releaseSettings,
        });
        acquiring = false;
        downloadCleanup = fetched.cleanup;
        const asset = releaseCopyRuntimeAsset(need.version);
        sourceNotes.push(
          fetched.attestation === "verified"
            ? `Downloaded ${asset} and verified its checksum and release attestation.`
            : fetched.attestation === "unsupported"
            ? `Downloaded ${asset} and verified its checksum; this gh cannot verify release attestations (upgrading it would), so its release attestation was not checked.`
            : `Downloaded ${asset} and verified its checksum; gh is not installed, so its release attestation was not checked.`,
        );
        selected = selectSource(
          requestedHarness ?? need.distribution,
          fetched.archive,
          existing.distribution,
          requiredVersion,
        );
      }
      recordOnly = false;
    }
    if (!selected) throw new Error("no configuration source was selected");
    if (selected.note) sourceNotes.push(selected.note);
    if (pendingConfirm && !askedConfirm) {
      const first = [
        updateFirst ? `This first updates ${updateFirst}.` : "",
        registerPin ? `It also registers this project's ${registerPin.version} pin on this machine.` : "",
      ].filter(Boolean).join(" ");
      const answer = configPrompt(`${pendingConfirm.question}${first ? ` ${first}` : ""} [y/N]:`);
      if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
        emitResult(usage(pendingConfirm.cancelled), options);
        return;
      }
    }
    const { stamp, descriptor } = selected;
    configTargetHarnessDir = descriptor.harnessDir;
    if (existing.distribution && existing.distribution !== stamp.distribution) {
      throw new Error(`project uses ${existing.distribution}; refusing ${stamp.distribution}`);
    }
    const installed = discoverProjectHarnesses(projectDir);
    // The harness this run replaces in its own directory, if any. A switch is
    // a refresh of that directory: it plans from the occupant's ownership
    // baseline and, like any refresh, is done while work is open.
    let switchingFrom: ProjectHarness | undefined;
    if (!existing.distribution) {
      const collision = installed.find(
        (candidate) => candidate.harnessDir === descriptor.harnessDir,
      );
      if (collision && !switchesInPlace(collision.distribution, stamp.distribution)) {
        throw new Error(
          `harness ${stamp.distribution} shares directory ${descriptor.harnessDir} with installed ${collision.distribution}; they cannot coexist in one project`,
        );
      }
      if (collision) {
        // The planner reads every shipped file under the hooks directory, so a
        // redirected or unlistable one is refused before anything is read.
        assertHooksDirReviewable(projectDir, `${descriptor.harnessDir}/hooks`, descriptor.harnessDir, stamp.distribution);
        switchingFrom = collision;
        // A switch brings in the other row's files, so it is never a
        // records-only settings change.
        recordOnly = false;
      }
    }
    const refreshing = Boolean(existing.distribution || switchingFrom);
    const switchedRows = switchingFrom ? { from: switchingFrom.distribution, to: stamp.distribution } : undefined;
    for (const sibling of installed) {
      if (sibling.harnessDir === descriptor.harnessDir) continue;
      const siblingProjection = siblingDescriptor(sibling);
      if (!siblingProjection) {
        if (refreshing) {
          const baseline = siblingBaseline(sibling);
          for (const integration of descriptor.rootIntegrations) {
            if (integration.policy !== "managed-block" || integration.shared === "union") continue;
            const contribution = baseline?.rootContributions?.[integration.path];
            if (contribution?.policy === "managed-block") {
              if (integration.shared === "identical") {
                const currentHash = unchangedManagedBlockHash(projectDir, selected.root, descriptor.harnessDir, integration);
                if (currentHash && contribution.hash === currentHash) continue;
              }
              throw new Error(
                `refusing to refresh ${stamp.distribution} while installed ${sibling.distribution} co-owns ${integration.path} but has no readable projection descriptor (${sibling.harnessDir}/tools/data/aidlc-projection.json); run aidlc config --harness ${sibling.distribution} first`,
              );
            } else if (
              sibling.frameworkVersion !== undefined && baseline === null &&
              !unchangedManagedBlockHash(projectDir, selected.root, descriptor.harnessDir, integration)
            ) {
              throw new Error(
                `refusing to refresh ${stamp.distribution} while installed ${sibling.distribution} has lost its projection descriptor and ownership baseline; run aidlc config --harness ${sibling.distribution} first`,
              );
            }
          }
          continue;
        }
        throw new Error(
          `harness ${stamp.distribution} cannot be added while installed ${sibling.distribution} has no readable projection descriptor (${sibling.harnessDir}/tools/data/aidlc-projection.json); run aidlc config --harness ${sibling.distribution} first`,
        );
      }
      for (const integration of descriptor.rootIntegrations) {
        if (integration.policy !== "managed-block" || integration.shared === "union") continue;
        const collision = siblingProjection.rootIntegrations.find((candidate) =>
          candidate.path === integration.path && candidate.policy === "managed-block" &&
          !(integration.shared === "identical" && candidate.shared === "identical")
        );
        if (collision) {
          if (refreshing && !integration.shared && collision.shared === "identical") {
            throw new Error(
              `refusing to refresh ${stamp.distribution} from a release whose ${integration.path} is not shared while installed ${sibling.distribution} shares it; use a release that declares it shared`,
            );
          }
          if (
            integration.shared === "identical" &&
            predatesFrameworkVersion(sibling.frameworkVersion, stamp.frameworkVersion)
          ) {
            throw new Error(
              `harness ${stamp.distribution} shares ${integration.path} with installed ${sibling.distribution}, whose install predates shared onboarding; run aidlc config --harness ${sibling.distribution} first — if it still refuses afterwards, its ${integration.path} is exclusive and they cannot coexist in one project`,
            );
          }
          throw new Error(
            `harness ${stamp.distribution} shares ${integration.path} with installed ${sibling.distribution}; they cannot coexist in one project`,
          );
        }
      }
    }
    if (requiredVersion !== undefined && requiredVersion !== stamp.frameworkVersion) {
      throw new MissingInstalledSource(
        `project pin requires ${requiredVersion}, but source is ${stamp.frameworkVersion}; run aidlc config --pin ${requiredVersion}`,
        stamp.distribution,
        requiredVersion,
      );
    }
    // Checked again just before planning: the baseline the switch plans from
    // is the one this check accepted, even after a long download.
    if (switchingFrom) assertSwitchBaseline(switchingFrom, stamp.distribution);
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
      recordOnly,
      Boolean(selected.projectProjection),
      diagnosticsContext?.overrides ?? choicesContext?.overrides,
    );
    prepared.notes.unshift(...sourceNotes);
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
    // Servers a release shipped that the project already has stay on until the
    // person turns them off.
    const keepPresentServers = choicesContext?.keepPresentServers === true ||
      (!mcpMode && holdsShippedServers(projectDir, descriptor));
    if (keepPresentServers) mcpMode = "defaults";
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
    // A manifest-less copy-channel projection has no baseline to retain.
    // Record its current projection on the first record-only command so a
    // later release refresh can distinguish owned bytes from local drift.
    // A copied project is not a release: whenever its own files are the source,
    // keep the baseline it already has instead of adopting its current bytes.
    const retainBaseline = Boolean(selected.projectProjection) && prior !== null;
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
      retainBaseline,
      prepared.projectOverlays,
      prepared.unproven,
    );
    for (const rel of prepared.retiredManagedFiles) {
      const target = join(projectDir, rel);
      if (!pathPresent(target)) continue;
      operations.push({ kind: "remove", path: rel, expected: expected(target) });
      actions.push({
        path: rel,
        action: "remove",
        detail: "retired attributable manifestless hook",
      });
    }
    if (!selected.projectProjection) {
      planRootIntegrations(
        projectDir,
        prepared.root,
        descriptor,
        prior,
        mcpMode,
        argv.includes("--force"),
        recordOnly,
        retainBaseline,
        operations,
        actions,
        rootContributions,
        false,
        keepPresentServers,
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
      // Project choices from the project's own files change only .mcp.json. Its
      // managed .gitignore block is never planned from them: that copy is the
      // user's whole merged file, not the block a release ships.
      const presentRootIntegrations = descriptor.rootIntegrations.filter(
        (integration) =>
          (ownFilesProject
            ? integration.policy === "json-map"
            : prior === null || preparedRegenerated.has(integration.path)) &&
          regularFile(shippedRootIntegrationPath(preparedRoot, descriptor.harnessDir, integration)),
      );
      if (presentRootIntegrations.length > 0) {
        planRootIntegrations(
          projectDir,
          preparedRoot,
          { ...descriptor, rootIntegrations: presentRootIntegrations },
          prior,
          mcpMode,
          argv.includes("--force"),
          recordOnly,
          retainBaseline,
          operations,
          actions,
          rootContributions,
          ownFilesProject,
          keepPresentServers,
          true,
        );
      }
    }
    const settingsExclude = planProjectSettingsMutation(
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
      // The refusal keeps the person's edits; the way forward is theirs. Moving
      // a cited file aside clears every kind of conflict; --force clears only
      // an edit to a file AI-DLC owns, so it is named only when that is all.
      const forceable = (detail: string | undefined): boolean =>
        /^(?:managed path is not a regular file|locally modified or unowned|removed upstream but locally modified|root integration is not a regular file|managed block was locally modified|managed block has no ownership baseline|retired managed block was locally modified|retired JSON entry was locally modified|retired whole-file integration was locally modified)$/
          .test(detail ?? "") || /is missing its shipped block copy/.test(detail ?? "");
      const cited = [...new Set(conflicts.map((item) => item.path))];
      const broken = [...new Set(conflicts.filter((item) => !forceable(item.detail)).map((item) => item.path))];
      const one = cited.length === 1;
      const listed = (paths: string[]): string => paths.length === 1 ? paths[0] : paths.join(", ");
      const forward = broken.length === 0
        ? `to keep your version, move ${one ? cited[0] : "those files"} somewhere else and run ` +
          `the same command again; to take the shipped ${one ? "version" : "versions"} over ` +
          `${one ? "it" : "them"}, run it again with --force. ` +
          `\`${configCommand("--dry-run --verbose")}\` lists every change first.`
        : broken.length < cited.length
        ? `move ${listed(cited)} somewhere else (or fix ${listed(broken)} in place instead of moving ` +
          `${broken.length === 1 ? "it" : "them"}), then run the same command again. ` +
          `\`${configCommand("--dry-run --verbose")}\` lists every change first.`
        : `fix ${listed(broken)} in place, or move ${one ? "it" : "them"} somewhere else, then run the same ` +
          `command again. \`${configCommand("--dry-run --verbose")}\` lists every change first.`;
      emitResult({
        ...failure(
          `${conflicts.length} config conflict(s): ${conflicts.map((item) => `${item.path} (${item.detail})`).join(", ")}`,
          EXIT.integrity,
          forward,
        ),
        data: { projectDir, distribution: stamp.distribution, counts, actions },
      }, options);
      return;
    }
    // A user rule hiding records that travel by git is the user's choice, so
    // config names it and carries on. The managed block re-includes nothing,
    // so the rules on disk also describe the merged result, dry run included.
    const hiddenRecords =
      !choicesContext && !diagnosticsContext && !modelsContext &&
        descriptor.rootIntegrations.some((integration) => integration.path === ".gitignore")
        ? committedRecordIgnoreConflicts(projectDir)
        : [];
    // Kiro's v3 engine and Kiro IDE run every hook JSON file in the hooks
    // directory; the v2 engine the agent-v1 row runs on reads none. A switch to
    // a row that registers its hooks that way names each such file AI-DLC does
    // not own, so the person sees what Kiro will now run, and binds the whole
    // set (names, bytes, modes) to the plan the person approves.
    const hooksDir = `${descriptor.harnessDir}/hooks`;
    const hookGate = Boolean(switchingFrom) &&
      Object.keys(files).some((rel) => rel.startsWith(`${hooksDir}/`) && rel.endsWith(".json"));
    // A link could pull in files the plan never saw, or make this run read
    // outside the project, so a switch refuses rather than follow one.
    // A hook file the plan removes (the installed row shipped it) is not one
    // Kiro will run, so it is neither named nor expected after the commit.
    const accounted: Record<string, string> = {
      ...files,
      ...Object.fromEntries(
        operations.filter((operation) => operation.kind === "remove").map((operation) => [operation.path, "remove"]),
      ),
    };
    const hookScan = hookGate
      ? scanUnownedHooks(projectDir, hooksDir, accounted)
      : { redirected: false, unreadable: false, entries: [] };
    // The directory itself was held reviewable before planning.
    const redirected = hookScan.entries.filter((entry) => !entry.regular).map((entry) => entry.path);
    if (redirected.length > 0) {
      throw new SwitchRefusal(
        `cannot switch ${descriptor.harnessDir} to ${stamp.distribution}: Kiro would run hooks through entries that are not regular files in ${hooksDir} ${
          repositoryNames(redirected.map(displayName))
        }; replace each with a regular file or move it out of ${hooksDir}`,
        {
          kind: "text",
          text: `replace each of ${repositoryNames(redirected.map(displayName))} with a regular file or move it out of ${hooksDir}, then run the switch again`,
        },
      );
    }
    const unownedHooks = hookScan.entries;
    // A file name is the repository's text: it is printed whole and quoted, with
    // every character outside printable ASCII spelled out, inside a parenthesis
    // that says it is data, not instructions.
    const hookNames = unownedHooks.map((hook) => displayName(hook.path));
    const framedHooks = repositoryNames(hookNames);
    for (const hook of unownedHooks) {
      actions.push({ path: hook.path, action: "preserve", detail: "hook file AI-DLC does not own, bound to this plan" });
    }
    const switchWarnings = hookNames.length > 0
      ? [`AI-DLC does not own ${hookNames.length === 1 ? "this hook file" : "these hook files"} ${framedHooks}; Kiro runs ${hookNames.length === 1 ? "it" : "them"} on its v3 engine, which ${descriptor.harnessDir}/settings/cli.json now pins, and in Kiro IDE`]
      : [];
    prepared.notes.push(...hiddenRecords, ...switchWarnings);
    if (actions.some((action) => action.detail === KEPT_GITIGNORE_LINES_DETAIL)) {
      prepared.notes.push(KEPT_GITIGNORE_LINES_NOTE);
    }
    // Older releases shipped an effort map in the project's Kiro settings; a
    // refresh that removes it says where the session's effort lives now.
    const legacyKiroMap = stamp.distribution === "kiro" &&
      !choicesContext && !diagnosticsContext && !modelsContext &&
      hasLegacyKiroEffortMap(projectDir, descriptor.harnessDir);
    // Quiet output is one line when clean. Like the outstanding-actions line,
    // each record-hiding rule and each switch warning adds one Warning line, on
    // dry run and apply.
    const quietWarnings = [...hiddenRecords, ...switchWarnings];
    const withQuietWarnings = (message: string): string =>
      options.mode === "quiet" && quietWarnings.length > 0
        ? `${message}${quietWarnings.map((warning) => `\nWarning: ${warning}`).join("")}`
        : message;
    const baseline: Baseline = {
      schemaVersion: 1,
      frameworkVersion: stamp.frameworkVersion,
      distribution: stamp.distribution,
      harnessDir: stamp.harnessDir,
      mcpMode,
      files,
      ...(!selected.projectProjection || prior?.shippedOnly ? { shippedOnly: true as const } : {}),
      entries: prepared.entries,
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
      ...(hookGate ? { unownedHooks } : {}),
      // The person's Kiro session changes outside the transaction, so the plan
      // names the session it starts from and what it asks for: a token approved
      // for one Kiro model never writes effort onto another.
      ...(pendingKiroSession
        ? {
            kiroSession: {
              current: pendingKiroSession.session.model,
              modelDefaults: pendingKiroSession.session.modelDefaults,
              setModel: pendingKiroSession.setModel ?? null,
              preset: pendingKiroSession.preset,
            },
          }
        : {}),
    };
    const planToken = sha256Bytes(canonical(approvalPlan));
    if (hookNames.length > 0 && argv.includes("--dry-run")) {
      const tokenLine = `to apply this plan with those hook files as they are now, rerun it without --dry-run and with --plan-token ${planToken}`;
      prepared.notes.push(tokenLine);
      quietWarnings.push(tokenLine);
    }
    if (argv.includes("--dry-run")) {
      if (modelsContext && options.mode === "human") {
        for (const line of modelsContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of modelsContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      // A dry run shows the personal Kiro settings change too, writing nothing.
      const kiroSessionPreview = pendingKiroSession
        ? await applyKiroSessionPlan({ ...pendingKiroSession, dryRun: true })
        : null;
      if (kiroSessionPreview && options.mode === "human") writeKiroSessionLines(kiroSessionPreview.lines);
      if (diagnosticsContext && options.mode === "human") {
        for (const line of diagnosticsContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of diagnosticsContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      if (choicesContext && options.mode === "human") {
        for (const line of choicesContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of choicesContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      if (options.mode === "human") {
        writeMenuLines("", retiredFilesReport(projectDir, actions, stamp.frameworkVersion, false, switchedRows));
        for (const note of prepared.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      const configuredSection = diagnosticsContext?.section ??
        choicesContext?.section ??
        (modelsContext ? "models" : null);
      emitResult(success(
        withQuietWarnings(`${configuredSection ? `${configuredSection} configuration` : "config"} plan for ${projectDir}${
          switchingFrom
            ? ` (switches ${descriptor.harnessDir} in place from ${switchingFrom.distribution} to ${stamp.distribution})`
            : ""
        }: ${
          Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")
        }`),
        {
          projectDir,
          distribution: stamp.distribution,
          counts,
          actions,
          planToken,
          notes: prepared.notes,
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
          ...(kiroSessionPreview ? kiroSessionData(kiroSessionPreview) : {}),
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
    // Whether Kiro may run hook files nobody here reviewed is the person's
    // call. They make it on these exact files: at the prompt, or by applying
    // the plan token a dry run printed for them.
    if (hookNames.length > 0 && approvedToken !== planToken) {
      if (options.mode === "human" && configInputIsTty()) {
        const answer = configPrompt(
          `Kiro will run hook files AI-DLC does not own ${framedHooks} once ${descriptor.harnessDir} is switched to ${stamp.distribution}. Switch anyway? [y/N]:`,
        );
        if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
          emitResult(usage(`switch cancelled; ${descriptor.harnessDir} was not changed`), options);
          return;
        }
      } else {
        emitResult(failure(
          `switching ${descriptor.harnessDir} to ${stamp.distribution} lets Kiro run hook files AI-DLC does not own ${framedHooks}; review them, then apply this plan with the --plan-token its dry run prints`,
          EXIT.integrity,
          configRerunWith(input, projectDir, ["--dry-run"]),
        ), options);
        return;
      }
    }
    // Under the transaction lock the hook set is read again before staging,
    // and once more after the files are committed, where a mismatch rolls the
    // switch back: a file added, removed, renamed, or changed between the
    // approval and the commit stops the switch.
    // Test seam: a writer that adds a hook file after approval, before the
    // transaction lock ("1") or while the switch commits ("committed"). The
    // file is an empty object, which registers nothing.
    const interference = hookGate ? process.env.AIDLC_TEST_SWITCH_HOOK_INTERFERENCE : undefined;
    const interfere = () =>
      writeFileSync(join(projectDir, hooksDir, "aidlc-test-interference.json"), "{}\n");
    if (interference === "1") interfere();
    const checkHooks = (committed: boolean) => {
      if (committed && interference === "committed") interfere();
      const now = scanUnownedHooks(projectDir, hooksDir, accounted);
      if (now.redirected || now.unreadable || canonical(now.entries) !== canonical(unownedHooks)) {
        throw new SwitchRefusal(
          committed
            ? `${hooksDir}: hook files AI-DLC does not own changed while this switch was applied, so it was rolled back; review them and run the switch again`
            : `${hooksDir}: hook files AI-DLC does not own changed after this switch was planned; review them and run the switch again`,
          { kind: "text", text: "run the switch with --dry-run again, review the hook files it names, and apply its new --plan-token" },
        );
      }
    };
    const hookChecks = hookGate
      ? { validateLocked: () => checkHooks(false), validateCommitted: () => checkHooks(true) }
      : {};
    // Open work that needs a plugin this change turns off stops until it is on
    // again; the same check select-plugins uses, read before the plugin's
    // stages leave the graph.
    const pluginsOff = choicesContext?.section === "project" && choicesContext.nextPlugins !== null &&
        canonical(choicesContext.previousPlugins) !== canonical(choicesContext.nextPlugins)
      ? activeWorkflowPluginDependencies(projectDir, new Set(choicesContext.nextPlugins))
      : [];
    if (refreshing) {
      withAuditLock(
        projectDir,
        () => {
          executeSettingsAndProjectMutation(settingsMutation, plan, hookChecks);
        },
        undefined,
        undefined,
        600,
      );
    } else {
      executeSettingsAndProjectMutation(settingsMutation, plan);
    }
    // Said as soon as it is done, so no later step can leave it unsaid.
    if (options.mode === "human") {
      writeMenuLines("", retiredFilesReport(projectDir, actions, stamp.frameworkVersion, true, switchedRows));
    }
    const excludeNote = excludeLocalSettingsFromClone(settingsExclude);
    if (excludeNote) prepared.notes.push(excludeNote);
    // The new routing is published only now that the project matches it: a
    // refusal or conflict above leaves the pin as it was. A pin that changed
    // while this ran is someone else's newer choice, so it is not overwritten.
    if (registerPin) {
      const current = regularFile(pinPath) ? readFileSync(pinPath, "utf-8").trim() : undefined;
      if (current !== registerPin.version) {
        prepared.notes.push(
          `The project pin changed while this ran, so this project's ${registerPin.version} pin was not registered.`,
        );
      } else {
        try {
          registerProjectPin(projectDir, registerPin.version);
          prepared.notes.push(`Registered this project's ${registerPin.version} pin on this machine.`);
        } catch (error) {
          emitResult(failure(
            `updated ${descriptor.harnessDir} to ${registerPin.version}, but registering this project's pin failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            EXIT.failure,
            configCommand(`--pin ${registerPin.version}${projectTarget(projectDir)}`),
          ), options);
          return;
        }
      }
    }
    if (settingsMutation && settingsMutation.target !== "global") {
      invalidateSettingsCache(settingsMutation.path);
    }
    const switchLines = choicesContext?.section === "flags" && choicesContext.settings
      ? recordSwitchChange(
          projectDir,
          choicesContext.settings.target,
          choicesContext.settings.previous,
          choicesContext.settings.next,
        )
      : [];
    if (modelsContext && options.mode === "human") {
      writeMenuLines("", modelsContext.summaryLines);
      writeMenuLines("", modelsContext.notes.map((note) => `  Note: ${note}`));
    }
    // The person's Kiro session is written once AI-DLC's own record is saved.
    const kiroSession = pendingKiroSession
      ? await applyKiroSessionPlan(pendingKiroSession)
      : null;
    if (kiroSession && options.mode === "human") writeKiroSessionLines(kiroSession.lines);
    if (diagnosticsContext && options.mode === "human") {
      writeMenuLines("", diagnosticsContext.summaryLines);
      writeMenuLines("", diagnosticsContext.notes.map((note) => `  Note: ${note}`));
    }
    if (choicesContext && options.mode === "human") {
      writeMenuLines("", choicesContext.summaryLines);
      writeMenuLines("", choicesContext.notes.map((note) => `  Note: ${note}`));
      writeMenuLines("", switchLines);
    }
    // What a recorded setting changed, the command that undoes it, and who
    // picks it up.
    const changes = [
      ...(settingsMutation ? settingsChangeLines(projectDir, [settingsMutation], descriptor.distribution) : []),
      ...(diagnosticsContext ? recordChangeLines(projectDir, diagnosticsContext) : []),
    ];
    // A model policy reaches running work only through the agent files it
    // rewrites; a harness whose agents inherit the session says so in a note.
    // Kiro CLI reads its agent files and its cli.json effort only when a
    // session starts, so there the change reaches open work from the next one.
    const policyHarness = modelHarness(descriptor.distribution);
    const agentsDir = modelPolicyAgentsDir(policyHarness, descriptor.harnessDir);
    const kiroCliSettings = policyHarness === "kiro" ? `${descriptor.harnessDir}/settings/cli.json` : null;
    const reachesWork = Boolean(settingsMutation) && (
      !modelsContext ||
      (agentsDir !== null &&
        actions.some((item) =>
          item.action !== "preserve" && (item.path.startsWith(`${agentsDir}/`) || item.path === kiroCliSettings)
        ))
    );
    if (choicesContext?.section === "project") changes.push(...projectChangeLines(projectDir, choicesContext));
    const openLine = recordOnly && reachesWork && settingsMutation
      ? openWorkflowLine(
        projectDir,
        [settingsMutation],
        modelsContext && policyHarness === "kiro" ? HARNESS_PRODUCT_NAMES.kiro : undefined,
      )
      : null;
    if (openLine) changes.push(openLine);
    if (!recordOnly) {
      changes.push(...refreshDoneLines(projectDir, {
        added: existing.distribution || switchingFrom ? undefined : descriptor.harnessDir,
        switched: switchingFrom !== undefined,
        from: prior?.frameworkVersion,
        to: stamp.frameworkVersion,
        pinned: requiredVersion !== undefined,
        copyChannel,
        releaseBaseUrl: releaseSettings.baseUrl,
        harness: descriptor.distribution,
        pluginsOff,
      }));
      changes.push(...treesLeftBehindLines(
        projectDir,
        { distribution: stamp.distribution, harnessDir: descriptor.harnessDir, version: stamp.frameworkVersion },
        {
          // Only files the person named can be named back to them.
          from: internal.sourceRoot === undefined ? valueAfter(argv, "--from") : undefined,
          holds: selected.holds,
          requiredVersion,
          copyChannel,
          releaseBaseUrl: releaseSettings.baseUrl,
        },
      ));
    }
    if (options.mode === "human") writeMenuLines("", changes.map((line) => `  ${line}`));
    // Cursor may skip project hooks in a folder outside any git repository
    // (issue #976), so such a project gets `git init` as its first next step,
    // and a Cursor already open on it has to restart to load the hooks.
    if (legacyKiroMap && !hasLegacyKiroEffortMap(projectDir, descriptor.harnessDir)) {
      prepared.notes.push(
        `This refresh removed AI-DLC's old effort map from ${descriptor.harnessDir}/settings/cli.json (claude-opus-4.8 at extra-high). AI-DLC now saves the session model and its effort in your personal Kiro settings: run \`${configCommand("models")}\` to choose them.`,
      );
    }
    const cursorOutsideGit = !choicesContext && !diagnosticsContext && !modelsContext &&
      descriptor.distribution === "cursor" && !insideGitRepository(projectDir);
    if (cursorOutsideGit) {
      prepared.notes.push(
        "This project is not in a git repository. Cursor may skip AI-DLC's hooks there, and without them your approvals are not recorded.",
      );
    }
    if (options.mode === "human") {
      writeMenuLines("", prepared.notes.map((note) => `  Note: ${note}`));
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
      : `configured ${projectDir} for ${descriptor.productName} ${stamp.frameworkVersion}${
        switchingFrom
          ? `, switched ${descriptor.harnessDir} in place from ${switchingFrom.distribution} to ${stamp.distribution} (aidlc/ kept)`
          : ""
      }; next: ${
        cursorOutsideGit
          ? "run `git init` in this project, then open it in Cursor and trust it (fully restart Cursor if it is already open), then run `/aidlc --doctor`"
          : descriptor.configNextStep
      }`;
    const setupMapWillRender =
      !internal.setupWalkChild &&
      !section &&
      options.mode === "human" &&
      configInputIsTty();
    const completion = configCompletionMessage(
      withQuietWarnings(baseMessage),
      setupMapWillRender ? [] : outstandingActions,
      options.mode,
    );
    // AI-DLC's record is saved, but the person's Kiro session is not what they
    // asked for until the printed command runs again.
    const kiroUnsaved = kiroSession !== null && !kiroSession.ok;
    const completed = kiroUnsaved ? `${completion}; your Kiro session was not saved` : completion;
    // A model change the person sees ends with what changed and its undo;
    // anything more only when something still needs them.
    if (modelsContext && options.mode === "human" && changes.length > 0 && !kiroUnsaved) {
      if (outstandingActions.length > 0) {
        process.stdout.write(`${menuText(configCompletionMessage("", outstandingActions, "human").trimStart())}\n`);
      }
      process.exitCode = EXIT.ok;
      return;
    }
    const configured = success(
      // Only the human line is laid out for the terminal; JSON and --quiet
      // output keep the message exactly.
      options.mode === "human" ? menuText(completed) : completed,
      {
        projectDir,
        distribution: stamp.distribution,
        version: stamp.frameworkVersion,
        counts,
        actions,
        planToken,
        notes: prepared.notes,
        ...(changes.length > 0 ? { changes } : {}),
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
        ...(kiroSession ? kiroSessionData(kiroSession) : {}),
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
        ...(switchLines.length > 0 ? { switches: switchLines } : {}),
      },
    );
    emitResult(
      kiroUnsaved
        ? { ...configured, ok: false, code: EXIT.actionNeeded, status: "action-needed", remediation: configCommand("models") }
        : configured,
      options,
    );
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
    // A question with no answer is not a failure to report as one.
    if (error instanceof FirstRunCancelled) {
      process.stdout.write(noAnswerLines(error, configRerunWith(input, projectDir, []) ?? configCommand(projectTarget(projectDir))));
      process.exitCode = EXIT.usage;
      return;
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const copyChannel = aidlcInvocation() !== "aidlc";
    // A pin refusing the files named by --from wants the pinned release itself,
    // fetched instead of those files.
    const pinMismatch = error instanceof MissingInstalledSource && from ? error : null;
    const needed: ReleaseNeed | null = error instanceof NeedsRelease
      ? error.need
      : pinMismatch?.requiredVersion
      ? {
          cause: "from",
          version: pinMismatch.requiredVersion,
          distribution: pinMismatch.distribution,
          current: selected?.stamp.frameworkVersion,
        }
      : null;
    // A download that could not complete: the network, the release host, or
    // offline settings. A failed checksum or attestation is not one of these,
    // and neither is a release that lacks the harness.
    const downloadFailed = acquiring &&
        activeNeed &&
        !(error instanceof ReleaseVerificationError) &&
        (error instanceof LifecycleCommandError
          ? error.exitCode === EXIT.unavailable
          : error instanceof ReleaseUnavailableError)
      ? activeNeed
      : null;
    // Transport errors name the URL they failed on, path included, and a
    // mirror's path can be its credential: show origins only. The whole run up
    // to whitespace is one URL, quotes and apostrophes included, since a path
    // may legally hold them.
    const safeMessage = rawMessage.replace(/\bhttps?:\/\/\S+/gi, (match) => {
      try {
        return new URL(match).origin;
      } catch {
        return "the release mirror";
      }
    });
    const release = needed ?? downloadFailed;
    if (release) {
      const sentence = releaseNeedSentence(release);
      const lead = `${sentence[0].toLowerCase()}${sentence.slice(1, -1)}`;
      // The root refresh and `config project` take the file as their source.
      // A record-only section has no source flag (`config models --from` names
      // a preset), so its files are refreshed from the file first.
      const takesSource = !(modelsContext || diagnosticsContext || choicesContext?.section === "flags");
      const url = copyRuntimeUrl(release.version, valueAfter(argv, "--release-base-url"));
      const offline = copyChannel
        ? takesSource
          ? `offline: get ${url} and its .sha256 into one folder, then add --from <that file>`
          : `offline: get ${url} and its .sha256 into one folder, run ${configInvocationFor(projectDir)} config --harness ${release.distribution} --from <that file>${projectTarget(projectDir)}, then rerun this command`
        : `offline: ${
          configCommand(`--pin ${release.version} --offline --from <release directory>${projectTarget(projectDir)}`)
        }, then rerun this command`;
      emitResult(failure(
        downloadFailed ? `${lead}; the download failed: ${safeMessage}\n  ${offline}` : `${lead}\n  ${offline}`,
        downloadFailed ? EXIT.unavailable : EXIT.integrity,
        downloadFailed
          ? undefined
          : configRerunWith(
            input,
            projectDir,
            ["--download"],
            pinMismatch ? ["--from"] : [],
          ),
      ), options);
      return;
    }
    // Storage that cannot hold the transaction lock, or lacks an operation the
    // transaction needs, is about the filesystem, not the source or the
    // harness, so the fix names the storage.
    if (error instanceof TransactionFilesystemError) {
      emitResult(failure(rawMessage, EXIT.integrity, error.remediation), options);
      return;
    }
    if (error instanceof ProjectLinkError) {
      const rerun = configRerunWith(input, projectDir, []);
      emitResult(failure(
        rawMessage,
        EXIT.integrity,
        `put the file itself at ${shownValue(error.path)}, then run ${
          rerun ? `\`${rerun}\`` : "the same command"
        } again`,
      ), options);
      return;
    }
    if (error instanceof ReleaseVerificationError) {
      emitResult(failure(safeMessage, EXIT.integrity), options);
      return;
    }
    if (error instanceof LifecycleCommandError) {
      emitResult(failure(rawMessage, error.exitCode), options);
      return;
    }
    if (acquiring) {
      emitResult(failure(`${safeMessage}; the project was not changed`, EXIT.integrity), options);
      return;
    }
    const copiedHarness = discoverProjectHarnesses(projectDir).find((candidate) =>
      candidate.distribution === selected?.stamp.distribution
    );
    // A --from folder with no AI-DLC harness in it (or several) is said in the
    // person's words, with the files it needs.
    const harnessCount = from ? /expected exactly one projected harness directory, found (\d+)/.exec(rawMessage)?.[1] : undefined;
    const fromMessage = harnessCount === undefined
      ? rawMessage
      : harnessCount === "0"
      ? `${JSON.stringify(from)} holds no AI-DLC release files`
      : `${JSON.stringify(from)} holds ${harnessCount} AI-DLC harness folders, and config needs the one for this project`;
    emitResult(failure(
      fromMessage,
      /pass (?:one )?--harness|--harness requires|multi-harness config/.test(rawMessage)
        ? EXIT.usage
        : EXIT.integrity,
      error instanceof SwitchRefusal
        ? error.remedy.kind === "update"
          ? "update AI-DLC to the release that wrote this baseline, then run the switch again"
          : error.remedy.kind === "text"
          ? error.remedy.text
          : error.remedy.kind === "refresh"
          ? switchRefreshSteps(projectDir, error.remedy)
          : `${configInvocationFor(projectDir)} config ${from ? `--from ${quoteCommandArgument(from)} ` : ""}--harness ${
            error.remedy.harness
          }${projectTarget(projectDir)}`
        : from
        ? `pass --from the release files: aidlc-copy-runtime-X.Y.Z.tar.gz, the runtime/ folder inside it, or one harness folder such as runtime/${requestedHarness ?? copiedHarness?.distribution ?? "claude"}/; or fetch them with ${
          configRerunWith(input, projectDir, ["--download"], ["--from"]) ?? configCommand(`--download${projectTarget(projectDir)}`)
        }`
        : selected?.projectProjection && copiedHarness
        ? `re-copy the complete runtime/${copiedHarness.distribution}/ root from aidlc-copy-runtime-X.Y.Z.tar.gz (or a checkout's dist/${copiedHarness.distribution}/ tree) over the project, or install the native aidlc command`
        : configCommand("--harness <name>"),
    ), options);
  } finally {
    if (prepared?.cleanup) rmSync(prepared.cleanup, { recursive: true, force: true });
    if (selected?.cleanup) rmSync(selected.cleanup, { recursive: true, force: true });
    if (downloadCleanup) rmSync(downloadCleanup, { recursive: true, force: true });
    try {
      releaseHold?.();
    } catch {
      // A reservation left behind only delays a prune; the next scan reaps it.
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = EXIT.failure;
  });
}
