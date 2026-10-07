import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as hostPlatform } from "node:os";
import { delimiter, dirname, extname, join, relative, resolve } from "node:path";
import {
  assertProjectionPathHasNoSymlinks,
  isSafeOnboardingPath,
  jsonFileText,
  jsoncRootMembers,
  jsoncSettingValue,
  managedBlockIsSafe,
  managedBlockMarkers,
  mergeBlock,
  missingJsonEntries,
  readJsonFile,
  type RootIntegration,
  rootBlockPath,
  sha256Matching,
} from "./aidlc-distribution.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
  kiroTreeLayout,
} from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import { compareVersions, VERSION_ID } from "./aidlc-channel.ts";
import { installedExecutablePath } from "./aidlc-install-paths.ts";
import { readBoundedRegularFile } from "./aidlc-inline-context.ts";
import {
  HARNESS_PRODUCT_NAMES,
  sessionSetsAgentModels,
  type ModelHarness,
} from "./aidlc-model-policy.ts";
import {
  LOCAL_SETTINGS_FILE,
  localSettingsPath,
  machineSettingsPath,
  projectSettingsPath,
  RECORDABLE_PROJECT_BYPASSES,
  readSettingsTarget,
  resolveAidlcSettings,
  type ProjectFlagsRecord,
  type ResolvedAidlcSettings,
} from "./aidlc-settings.ts";

export type RuntimeRecord = {
  schemaVersion: 1;
  baselinePath?: string;
  bunPath?: string;
  aidlcPath?: string;
  cliPath?: string;
};

// `builtin` remains readable for records written by earlier builds. New provider
// answers use `current`, `amazon-bedrock`, or `other`.
export type ProviderKind = "current" | "amazon-bedrock" | "builtin" | "other";

// Kiro CLI and Kiro IDE provide their own model access. AI-DLC has no provider
// decision to ask, write, or check for them, even when a legacy answer exists.
export type BedrockOrientedHarness = Exclude<ModelHarness, "kiro" | "kiro-ide">;

const HARNESS_OWNED_MODEL_ACCESS: ReadonlySet<ModelHarness> = new Set<ModelHarness>([
  "kiro",
  "kiro-ide",
]);

export function harnessOwnsModelAccess(
  harness: ModelHarness,
): harness is Exclude<ModelHarness, BedrockOrientedHarness> {
  return HARNESS_OWNED_MODEL_ACCESS.has(harness);
}

// On hosts where the session sets every agent's model (Copilot, Cursor), no
// provider answer means the session's own model access, as the Models row
// says: not a gap for setup, doctor or `--check`. Bedrock stays a choice there.
export function providerAnswerIsTheSession(harness: ModelHarness): boolean {
  return !harnessOwnsModelAccess(harness) && sessionSetsAgentModels(harness);
}

export function sessionModelAccessFact(harness: ModelHarness): string {
  return `model access comes with your ${HARNESS_PRODUCT_NAMES[harness]} session`;
}

export function ownedModelAccessFact(product: string): string {
  return `Model access comes with ${product}; AI-DLC configures no model provider for it.`;
}

export type ProviderMenuCopy = { bedrock: string };

export function providerMenuCopy(
  harness: BedrockOrientedHarness,
): ProviderMenuCopy {
  switch (harness) {
    case "claude":
      return { bedrock: "write the AWS region and profile to settings.json" };
    case "codex":
      return { bedrock: "record the AWS region and profile and guide user-level Codex setup" };
    case "opencode":
      return { bedrock: "record the AWS region and profile and offer to write opencode.json" };
    case "copilot":
      return { bedrock: "record the manual Copilot BYOK provider setup" };
    case "cursor":
      return { bedrock: "record the manual Cursor provider setup" };
  }
}
export type ProviderPendingStatus = "pending" | "done";
export type ProviderPendingAction = {
  id: string;
  status: ProviderPendingStatus;
};

export type ProvidersRecord = {
  schemaVersion: 1;
  provider?: ProviderKind;
  region?: string;
  profile?: string;
  opencodeDefault?: boolean;
  acknowledged?: boolean;
  pendingActions?: ProviderPendingAction[];
};

export type TrustRecord = {
  schemaVersion: 1;
  reviewed?: boolean;
};

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell" | "none";

export type ProjectChoicesRecord = {
  schemaVersion: 1;
  mcp?: "defaults" | "none";
  completions?: CompletionShell;
};

export type ConfigDiagnosticRecords = {
  runtime: RuntimeRecord | null;
  providers: ProvidersRecord | null;
  trust: TrustRecord | null;
  project: ProjectChoicesRecord | null;
};

export type ConfigDiagnosticOverrides = {
  runtime?: RuntimeRecord | null;
  providers?: ProvidersRecord | null;
  trust?: TrustRecord | null;
  project?: ProjectChoicesRecord | null;
  plugins?: string[] | null;
};

function invocationForHarness(harnessDir: string): string {
  return aidlcInvocation() === "aidlc"
    ? "aidlc"
    : `bun ${harnessDir}/tools/aidlc.ts`;
}

// The one command that rebuilds a missing workspace shell: an explicit
// `--harness` refresh, which goes through the refresh transaction instead of the
// interactive existing-projection walk. Every surface that names the rebuild
// (doctor row, setup map, trust issue) renders it from here.
//
// A native install refreshes from its installed runtime. A projection that
// invokes through the bun dispatcher has no installed runtime, so its command
// also carries `--download`, which fetches and verifies the copy runtime for the
// project's release; the native runtime is the wrong source there, since
// refreshing from it would swap the hooks and tools to the `aidlc` command.
export function workspaceShellRefreshCommand(
  harnessDir: string,
  distribution: string,
): string {
  const invoke = invocationForHarness(harnessDir);
  return `${invoke} config --harness ${distribution}${invoke === "aidlc" ? "" : " --download"}`;
}

export type RuntimeBinaryProbe = {
  name: "bun" | "aidlc";
  required: boolean;
  status: "found" | "interactive-only" | "missing" | "not-required";
  baselinePath?: string;
  interactivePath?: string;
  remediation?: string;
};

export type HarnessCliProbe = {
  harness: ModelHarness;
  command?: string;
  required: boolean;
  status: "found" | "missing" | "too-old" | "not-applicable";
  path?: string;
  version?: string;
  minimumVersion?: string;
  remediation?: string;
};

export type RuntimeDiagnostics = {
  baselinePath: string;
  commandFiles: string[];
  binaries: RuntimeBinaryProbe[];
  cli: HarnessCliProbe;
};

export type AwsCredentialDiagnostics = {
  hasCredentials: boolean;
  sources: string[];
  profiles: string[];
  regions: string[];
  files: string[];
};

export type DiagnosticIssue = {
  id: string;
  message: string;
  remediation: string;
  severity?: "warn";
};

export type DiagnosticFileSetting = {
  setting: string;
  file: string;
};

export type TrustStatus = {
  files: string[];
  issues: DiagnosticIssue[];
};

export type DiagnosticDoctorCheck = {
  pass: boolean;
  severity?: "warn";
  label: string;
  fix?: string;
};

export type RuntimeProbeOptions = {
  baselinePath?: string;
  interactivePath?: string;
  includeHarnessCli?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Root the system PATH registries (/etc/...) are read under; tests point it at a fixture. */
  systemRoot?: string;
  platform?: NodeJS.Platform;
  which?: (command: string, pathValue: string) => string | null;
  run?: (
    command: string,
    args: readonly string[],
  ) => { status: number; stdout: string };
};

export type CredentialProbeOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
};

const RUNTIME_KEYS = new Set([
  "schemaVersion",
  "baselinePath",
  "bunPath",
  "aidlcPath",
  "cliPath",
]);
const PROVIDER_KEYS = new Set([
  "schemaVersion",
  "provider",
  "region",
  "profile",
  "opencodeDefault",
  "acknowledged",
  "pendingActions",
]);
const TRUST_KEYS = new Set(["schemaVersion", "reviewed"]);
const PROJECT_KEYS = new Set(["schemaVersion", "mcp", "completions"]);
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const PENDING_ACTION_IDS = [
  "bedrock-model-access",
  "codex-provider-configuration",
  // Retired IDs remain readable so legacy records can be reset.
  "kiro-ide-chat-model",
  "copilot-byok-configuration",
  "cursor-provider-configuration",
  "non-bedrock-provider-configuration",
] as const;
export type ProviderPendingActionId = (typeof PENDING_ACTION_IDS)[number];

export const PROVIDER_PENDING_ACTIONS: Record<
  ProviderPendingActionId,
  { label: string; remediation: string }
> = {
  "bedrock-model-access": {
    label:
      "Verify Amazon Bedrock model access in the recorded region and confirm the AWS principal has bedrock:InvokeModel permission.",
    remediation:
      "Open the Amazon Bedrock console for the recorded region, verify the required Anthropic models are available, and confirm IAM allows bedrock:InvokeModel.",
  },
  "codex-provider-configuration": {
    label:
      "Configure the selected provider in the user-level Codex configuration.",
    remediation:
      "Configure the provider, credentials, and model in $CODEX_HOME/config.toml (normally ~/.codex/config.toml). " +
      "For Bedrock, add model_provider = \"amazon-bedrock\", select model = \"<Bedrock model ID>\", and add " +
      "[model_providers.amazon-bedrock.aws] with profile = \"<AWS profile>\" and region = \"<AWS region>\". " +
      "Then acknowledge the manual setup.",
  },
  "kiro-ide-chat-model": {
    label:
      "Select the intended Amazon Bedrock chat model in the Kiro IDE model picker or with /model in Kiro CLI.",
    remediation:
      "Choose the intended Bedrock model in the Kiro IDE chat model picker, or with /model in Kiro CLI, then rerun this check.",
  },
  "copilot-byok-configuration": {
    label:
      "Configure GitHub Copilot BYOK provider environment variables for this install.",
    remediation:
      "Set COPILOT_PROVIDER_BASE_URL and COPILOT_PROVIDER_TYPE=anthropic for the Bedrock-compatible endpoint, then verify the Copilot session uses it.",
  },
  "cursor-provider-configuration": {
    label:
      "Configure the provider in Cursor and select it for the active chat session.",
    remediation:
      "Configure the provider in Cursor settings and select the intended model in the session model picker.",
  },
  "non-bedrock-provider-configuration": {
    label:
      "Configure the selected non-Bedrock provider in the harness.",
    remediation:
      "Follow the selected harness provider documentation, configure credentials and model selection, then acknowledge the manual setup.",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return raw.trim();
}

export function normalizeRuntimeRecord(value: unknown): RuntimeRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("runtime record must be an object with schemaVersion 1");
  }
  const unknown = unknownKeys(value, RUNTIME_KEYS);
  if (unknown.length > 0) {
    throw new Error(`runtime record has unknown key(s): ${unknown.join(", ")}`);
  }
  const out: RuntimeRecord = { schemaVersion: 1 };
  for (const key of ["baselinePath", "bunPath", "aidlcPath", "cliPath"] as const) {
    const parsed = optionalString(value, key, "runtime");
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

function normalizePendingActions(value: unknown): ProviderPendingAction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("providers.pendingActions must be an array");
  const seen = new Set<string>();
  const out: ProviderPendingAction[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).some((key) => key !== "id" && key !== "status") ||
      typeof raw.id !== "string" ||
      !(PENDING_ACTION_IDS as readonly string[]).includes(raw.id) ||
      (raw.status !== "pending" && raw.status !== "done")
    ) {
      throw new Error("providers.pendingActions entries require a known id and pending|done status");
    }
    if (seen.has(raw.id)) throw new Error(`duplicate provider pending action ${raw.id}`);
    seen.add(raw.id);
    out.push({
      id: raw.id,
      status: raw.status,
    });
  }
  return out.sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizeProvidersRecord(value: unknown): ProvidersRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("providers record must be an object with schemaVersion 1");
  }
  const unknown = unknownKeys(value, PROVIDER_KEYS);
  if (unknown.length > 0) {
    throw new Error(`providers record has unknown key(s): ${unknown.join(", ")}`);
  }
  const out: ProvidersRecord = { schemaVersion: 1 };
  if (value.provider !== undefined) {
    if (
      value.provider !== "current" &&
      value.provider !== "amazon-bedrock" &&
      value.provider !== "builtin" &&
      value.provider !== "other"
    ) {
      throw new Error("providers.provider must be current, amazon-bedrock, builtin, or other");
    }
    out.provider = value.provider;
  }
  for (const key of ["region", "profile"] as const) {
    const parsed = optionalString(value, key, "providers");
    if (parsed !== undefined) {
      if (!SAFE_VALUE.test(parsed)) {
        throw new Error(`providers.${key} contains unsupported characters`);
      }
      out[key] = parsed;
    }
  }
  for (const key of ["opencodeDefault", "acknowledged"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`providers.${key} must be true or false`);
    }
    if (typeof value[key] === "boolean") out[key] = value[key];
  }
  const pendingActions = normalizePendingActions(value.pendingActions);
  if (pendingActions && pendingActions.length > 0) out.pendingActions = pendingActions;
  return out;
}

export function normalizeTrustRecord(value: unknown): TrustRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("trust record must be an object with schemaVersion 1");
  }
  const unknown = unknownKeys(value, TRUST_KEYS);
  if (unknown.length > 0) {
    throw new Error(`trust record has unknown key(s): ${unknown.join(", ")}`);
  }
  if (value.reviewed !== undefined && typeof value.reviewed !== "boolean") {
    throw new Error("trust.reviewed must be true or false");
  }
  return {
    schemaVersion: 1,
    ...(typeof value.reviewed === "boolean" ? { reviewed: value.reviewed } : {}),
  };
}

export function normalizeProjectChoicesRecord(
  value: unknown,
): ProjectChoicesRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("project record must be an object with schemaVersion 1");
  }
  const unknown = unknownKeys(value, PROJECT_KEYS);
  if (unknown.length > 0) {
    throw new Error(`project record has unknown key(s): ${unknown.join(", ")}`);
  }
  const out: ProjectChoicesRecord = { schemaVersion: 1 };
  if (value.mcp !== undefined) {
    if (value.mcp !== "defaults" && value.mcp !== "none") {
      throw new Error("project.mcp must be defaults or none");
    }
    out.mcp = value.mcp;
  }
  if (value.completions !== undefined) {
    if (
      typeof value.completions !== "string" ||
      !["bash", "zsh", "fish", "powershell", "none"].includes(value.completions)
    ) {
      throw new Error(
        "project.completions must be bash, zsh, fish, powershell, or none",
      );
    }
    out.completions = value.completions as CompletionShell;
  }
  return out;
}

export function readConfigDiagnosticRecords(harnessRoot: string): ConfigDiagnosticRecords {
  const path = join(harnessRoot, "tools", "data", "harness.json");
  const value = readJsonFile(path) as Record<string, unknown>;
  const policyKeys = ["models", "flags"].filter((key) => Object.hasOwn(value, key));
  if (policyKeys.length > 0) {
    throw new Error(
      `${path}: harness.json contains legacy policy key(s) ${policyKeys.join(", ")}. ` +
        `Remove ${policyKeys.join(", ")} from ${path}, then run ` +
        `'${aidlcInvocation()} config' to record policy in aidlc.settings.json.`,
    );
  }
  const distribution = value.distribution;
  if (
    distribution !== "claude" &&
    distribution !== "codex" &&
    distribution !== "copilot" &&
    distribution !== "cursor" &&
    distribution !== "kiro" &&
    distribution !== "kiro-ide" &&
    distribution !== "opencode"
  ) {
    throw new Error(`${path}: distribution must name a supported harness`);
  }
  const providers = normalizeProvidersRecord(value.providers);
  return {
    runtime: normalizeRuntimeRecord(value.runtime),
    providers: providers
      ? harnessOwnsModelAccess(distribution)
        ? providers
        : reconcileProviderActions(providers, distribution, false)
      : null,
    trust: normalizeTrustRecord(value.trust),
    project: normalizeProjectChoicesRecord(value.project),
  };
}

function defaultRun(
  command: string,
  args: readonly string[],
): { status: number; stdout: string } {
  // Windows runs a .cmd or .bat (what npm installs, for example copilot.cmd)
  // only through cmd.exe. The path is quoted whole; one that cmd.exe would
  // expand (% or !) or cannot quote (") is not run.
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    if (/[%!"]/.test(command) || args.some((arg) => !/^[A-Za-z0-9_./:=-]*$/.test(arg))) {
      return { status: -1, stdout: "" };
    }
    const result = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `""${command}" ${args.join(" ")}"`],
      { encoding: "utf-8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS, windowsVerbatimArguments: true },
    );
    return { status: result.status ?? -1, stdout: result.stdout ?? "" };
  }
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
  };
}

function pathEntries(value: string, platform: NodeJS.Platform): string[] {
  return value.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
}

function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || extname(command)) return [command];
  // Windows runs only a file with an executable extension; npm puts an
  // extensionless shell script beside its copilot.cmd, so it comes last.
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

export function resolveExecutableOnPath(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform = hostPlatform(),
): string | null {
  for (const directory of pathEntries(pathValue, platform)) {
    for (const candidate of executableCandidates(command, platform)) {
      const path = resolve(directory, candidate);
      try {
        if (!statSync(path).isFile()) continue;
        if (platform !== "win32") accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

export function deriveNonInteractivePath(
  options: RuntimeProbeOptions = {},
): string {
  if (options.baselinePath !== undefined) return options.baselinePath;
  const env = options.env ?? process.env;
  const platform = options.platform ?? hostPlatform();
  const run = options.run ?? defaultRun;
  if (platform === "win32") {
    const result = run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ]);
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    return env.SystemRoot
      ? `${join(env.SystemRoot, "System32")};${env.SystemRoot}`
      : env.PATH ?? "";
  }
  const result = run("getconf", ["PATH"]);
  const entries = pathEntries(
    result.status === 0 && result.stdout.trim()
      ? result.stdout.trim()
      : "/usr/local/bin:/usr/bin:/bin",
    platform,
  );
  const systemRoot = options.systemRoot ?? "/";
  if (platform === "darwin") {
    for (const path of [join(systemRoot, "etc", "paths")]) {
      if (!existsSync(path)) continue;
      entries.push(
        ...readFileSync(path, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      );
    }
    const pathsDir = join(systemRoot, "etc", "paths.d");
    if (existsSync(pathsDir)) {
      for (const file of readdirSync(pathsDir).sort()) {
        const path = join(pathsDir, file);
        try {
          if (!statSync(path).isFile()) continue;
          entries.push(
            ...readFileSync(path, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
          );
        } catch {
          // Ignore unreadable system path fragments.
        }
      }
    }
  } else {
    // getconf PATH is glibc's compile-time _CS_PATH (/bin:/usr/bin on the
    // Debian family), not what a login session or a systemd user service
    // receives. Those come from pam_env's /etc/environment, login.defs
    // ENV_PATH, and environment.d - the surfaces the remediation names.
    const home = options.home ?? env.HOME ?? homedir();
    const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
    entries.push(
      ...pathAssignments(join(systemRoot, "etc", "environment"), "pam-env", home),
      ...pathAssignments(join(systemRoot, "etc", "login.defs"), "login-defs", home),
      ...environmentDirectoryPaths(join(systemRoot, "etc", "environment.d"), home),
      ...environmentDirectoryPaths(join(configHome, "environment.d"), home),
    );
  }
  return [...new Set(entries)].join(delimiter);
}

// pam_env and login.defs values are literal; environment.d expands HOME and
// removes separator-carrying PATH splices. Entries with unresolved variables
// are discarded: blanking them would manufacture directories.
function pathAssignments(
  path: string,
  kind: "pam-env" | "login-defs" | "environment-d",
  home: string,
): string[] {
  let content: string;
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const prefix = kind === "login-defs"
    ? /^ENV_PATH\s+(?:PATH=)?(\S+)/
    : kind === "pam-env"
    ? /^(?:export\s+)?PATH=(.*)$/
    : /^PATH\s*=\s*(.*)$/;
  const entries: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const match = prefix.exec(line);
    if (!match) continue;
    let value = match[1];
    if (kind === "pam-env") {
      const comment = value.indexOf("#");
      if (comment !== -1) value = value.slice(0, comment);
    }
    if (kind !== "login-defs") {
      value = value.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    if (kind === "environment-d") {
      value = value
        .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => home)
        .replace(/\$\{PATH:\+:[^}]*\}/g, "")
        .replace(/\$\{PATH:\+[^}]*:\}/g, "");
    }
    for (const entry of value.split(":")) {
      const trimmed = entry.trim();
      if (trimmed && !trimmed.includes("$")) entries.push(trimmed);
    }
  }
  return entries;
}

// systemd environment.d: every *.conf in the directory, sorted, PATH= lines.
function environmentDirectoryPaths(directory: string, home: string): string[] {
  let files: string[];
  try {
    if (!existsSync(directory)) return [];
    files = readdirSync(directory).filter((file) => file.endsWith(".conf")).sort();
  } catch {
    return [];
  }
  return files.flatMap((file) => pathAssignments(join(directory, file), "environment-d", home));
}

function walkTextFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (path: string): void => {
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && /\.(?:json|jsonc|hook|md|toml)$/.test(entry.name)) {
          files.push(child);
        }
      }
    } catch {
      return;
    }
  };
  visit(root);
  return files.sort();
}

export function runtimeCommandFiles(
  projectDir: string,
  harnessDir: string,
): string[] {
  const roots = [
    join(projectDir, harnessDir, "hooks"),
    join(projectDir, harnessDir, "agents"),
    join(projectDir, harnessDir, "skills"),
    join(projectDir, ".github", "hooks"),
    join(projectDir, ".opencode", "command"),
  ];
  const direct = [
    join(projectDir, harnessDir, "settings.json"),
    join(projectDir, harnessDir, "hooks.json"),
    join(projectDir, harnessDir, "cli.json"),
  ].filter(existsSync);
  return [...new Set([...direct, ...roots.flatMap(walkTextFiles)])].sort();
}

function runtimeRequirements(files: readonly string[]): {
  bun: boolean;
  aidlc: boolean;
} {
  let bun = false;
  let aidlc = false;
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    bun ||= /\bbun\s+[^\n]*(?:aidlc|\.ts)/.test(text);
    aidlc ||= /\baidlc\s+engine\b/.test(text);
  }
  return { bun, aidlc };
}

function runtimePathSurfaces(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "a file in /etc/paths.d"
    : "the PATH line in /etc/environment, ENV_PATH in /etc/login.defs, or a PATH= line in ~/.config/environment.d/*.conf";
}

function runtimeRemediation(
  name: "bun" | "aidlc",
  platform: NodeJS.Platform,
  harness: ModelHarness,
  status: "interactive-only" | "missing" = "missing",
  foundAt?: string,
): string {
  const tool = HARNESS_PRODUCT_NAMES[harness];
  if (status === "interactive-only" && platform !== "win32") {
    // Found on this shell's PATH: a tool started from a terminal hands that
    // PATH to its hooks, so only a desktop or service launch can miss it. The
    // baseline reads no shell rc file, so editing one never clears this row.
    const dir = foundAt ? dirname(foundAt) : name === "bun" ? "~/.bun/bin" : "~/.local/bin";
    return `Nothing needs changing when you start ${tool} from a terminal: it hands that terminal's PATH to AI-DLC's hooks. ` +
      `If you start it from a desktop icon, the dock, or a service and AI-DLC's hooks do not run, add ${dir} to ${runtimePathSurfaces(platform)}, then restart ${tool}. ` +
      "Editing .bashrc or .zshrc does not change this check.";
  }
  if (name === "bun") {
    // Only a copied AI-DLC runs its hooks through bun; an installed one routes
    // them through `aidlc`. Say so, because a user who never chose to copy it
    // cannot otherwise tell why Bun is being asked for.
    const why = "AI-DLC in this project runs on Bun (the installed aidlc command does not need it). ";
    return platform === "win32"
      ? `${why}Install Bun, then add its install directory to the Windows User or Machine PATH, not only a shell profile.`
      : `${why}Install Bun, then add ~/.bun/bin to the PATH ${tool} starts with (${runtimePathSurfaces(platform)}), not only .zshrc or .bash_profile.`;
  }
  return platform === "win32"
    ? "Add the aidlc command directory to the Windows User or Machine PATH."
    : `Add ~/.local/bin to the PATH ${tool} starts with (${runtimePathSurfaces(platform)}), not only an interactive shell rc file.`;
}

function binaryProbe(
  name: "bun" | "aidlc",
  harness: ModelHarness,
  required: boolean,
  baselinePath: string,
  interactivePath: string,
  options: RuntimeProbeOptions,
): RuntimeBinaryProbe {
  if (!required) return { name, required, status: "not-required" };
  const platform = options.platform ?? hostPlatform();
  const which = options.which ?? ((command: string, pathValue: string) =>
    resolveExecutableOnPath(command, pathValue, platform));
  const baseline = which(name, baselinePath);
  const interactive = which(name, interactivePath);
  if (baseline) {
    return {
      name,
      required,
      status: "found",
      baselinePath: baseline,
      ...(interactive ? { interactivePath: interactive } : {}),
    };
  }
  if (interactive) {
    return {
      name,
      required,
      status: "interactive-only",
      interactivePath: interactive,
      remediation: runtimeRemediation(name, platform, harness, "interactive-only", interactive),
    };
  }
  return {
    name,
    required,
    status: "missing",
    remediation: runtimeRemediation(name, platform, harness),
  };
}

const HARNESS_CLI: Record<
  ModelHarness,
  {
    command?: string;
    required: boolean;
    minimumVersion?: string;
    install: string;
    // A PATH folder whose `command` is a stand-in that must never be run.
    standIn?: (directory: string) => boolean;
  }
> = {
  claude: {
    command: "claude",
    required: true,
    install: "Install Claude Code and ensure `claude --version` works.",
  },
  codex: {
    command: "codex",
    required: true,
    minimumVersion: "0.145.0",
    install: "Install or upgrade Codex CLI to 0.145.0 or later.",
  },
  copilot: {
    command: "copilot",
    required: false,
    minimumVersion: "1.0.74",
    install: "Install @github/copilot 1.0.74 or later for CLI use; VS Code-only installs may omit it.",
    standIn: isVsCodeCopilotStandInFolder,
  },
  cursor: {
    command: "cursor",
    required: false,
    install: "Install the Cursor CLI and ensure `cursor --version` works; IDE-only installs may omit it.",
  },
  // The 2.x line is where the hooks, skills and workspace default agent this
  // distribution relies on shipped; the guide asks for 2.6 or later.
  kiro: {
    command: "kiro-cli",
    required: true,
    minimumVersion: "2.6.0",
    install: "Install or upgrade Kiro CLI to 2.6.0 or later.",
  },
  // Probed so a machine with only a supported Kiro CLI detects this row next to
  // the kiro row: first-run setup then asks instead of silently choosing the
  // legacy one. 2.24.1 is the oldest Kiro CLI this row has been checked on (its
  // v3 engine runs the hooks, and `/aidlc --doctor` reports no problem); an
  // older one counts only for the kiro row, and doctor warns about it here.
  "kiro-ide": {
    command: "kiro-cli",
    required: false,
    minimumVersion: "2.24.1",
    install: "Kiro CLI is optional here: to run AI-DLC from a terminal, install or upgrade Kiro CLI to 2.24.1 or later; Kiro IDE-only installs may omit it.",
  },
  opencode: {
    command: "opencode",
    required: true,
    install: "Install opencode and ensure `opencode --version` works.",
  },
};

// VS Code's Copilot Chat writes a stand-in `copilot` to
// <user data>/User/globalStorage/github.copilot-chat/copilotCli and puts that
// folder on its terminals' PATH. With no real CLI the stand-in asks "Install
// GitHub Copilot CLI? (y/N)" on the console, past any pipe, and with an old
// one it offers an update. So the probe never runs it: like the stand-in
// itself, it looks past that folder for the real CLI.
function isVsCodeCopilotStandInFolder(directory: string): boolean {
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1)?.toLowerCase() === "copilotcli" &&
    parts.at(-2)?.toLowerCase() === "github.copilot-chat";
}

function versionTuple(value: string): [number, number, number] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function versionAtLeast(value: string, minimum: string): boolean {
  const actual = versionTuple(value);
  const expected = versionTuple(minimum);
  if (!actual || !expected) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

export function probeHarnessCli(
  harness: ModelHarness,
  options: RuntimeProbeOptions = {},
): HarnessCliProbe {
  const spec = HARNESS_CLI[harness];
  if (!spec.command) {
    return {
      harness,
      required: spec.required,
      status: "not-applicable",
      remediation: spec.install,
    };
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? hostPlatform();
  const interactivePath = options.interactivePath ?? env.PATH ?? "";
  const which = options.which ?? ((command: string, pathValue: string) =>
    resolveExecutableOnPath(command, pathValue, platform));
  const standIn = spec.standIn;
  const searchPath = standIn
    ? pathEntries(interactivePath, platform)
      .filter((directory) => !standIn(directory))
      .join(platform === "win32" ? ";" : delimiter)
    : interactivePath;
  const resolved = which(spec.command, searchPath);
  const path = resolved && standIn?.(resolved.replace(/[\\/][^\\/]*$/, ""))
    ? null
    : resolved;
  if (!path) {
    return {
      harness,
      command: spec.command,
      required: spec.required,
      status: "missing",
      ...(spec.minimumVersion ? { minimumVersion: spec.minimumVersion } : {}),
      remediation: spec.install,
    };
  }
  const run = options.run ?? defaultRun;
  const result = run(path, ["--version"]);
  const version = result.stdout.trim();
  // A floor needs a version: a reply with none is a stand-in, not the CLI.
  // VS Code's `copilot` prints "Cannot find GitHub Copilot CLI" and exits 0 (#1411).
  if (result.status !== 0 || (spec.minimumVersion && !versionTuple(version))) {
    return {
      harness,
      command: spec.command,
      required: spec.required,
      status: "missing",
      path,
      ...(spec.minimumVersion ? { minimumVersion: spec.minimumVersion } : {}),
      remediation: spec.install,
    };
  }
  if (spec.minimumVersion && !versionAtLeast(version, spec.minimumVersion)) {
    return {
      harness,
      command: spec.command,
      required: spec.required,
      status: "too-old",
      path,
      version,
      minimumVersion: spec.minimumVersion,
      remediation: spec.install,
    };
  }
  return {
    harness,
    command: spec.command,
    required: spec.required,
    status: "found",
    path,
    ...(version ? { version } : {}),
    ...(spec.minimumVersion ? { minimumVersion: spec.minimumVersion } : {}),
  };
}

export function probeRuntime(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  options: RuntimeProbeOptions = {},
): RuntimeDiagnostics {
  const env = options.env ?? process.env;
  const baselinePath = deriveNonInteractivePath(options);
  const interactivePath = options.interactivePath ?? env.PATH ?? "";
  const commandFiles = runtimeCommandFiles(projectDir, harnessDir);
  const requirements = runtimeRequirements(
    commandFiles.filter((file) =>
      !file.replaceAll("\\", "/").includes("/skills/")
    ),
  );
  return {
    baselinePath,
    commandFiles,
    binaries: [
      binaryProbe("bun", harness, requirements.bun, baselinePath, interactivePath, options),
      binaryProbe("aidlc", harness, requirements.aidlc, baselinePath, interactivePath, options),
    ],
    cli: options.includeHarnessCli === false
      ? {
          harness,
          required: false,
          status: "not-applicable",
        }
      : probeHarnessCli(harness, options),
  };
}

export function runtimeIssues(diagnostics: RuntimeDiagnostics): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  for (const binary of diagnostics.binaries) {
    if (binary.status === "found" || binary.status === "not-required") continue;
    issues.push({
      id: `runtime-${binary.name}-${binary.status}`,
      message: binary.status === "interactive-only"
        ? `${binary.name} resolves only through the interactive PATH at ${binary.interactivePath}`
        : `${binary.name} is absent from the non-interactive hook PATH`,
      remediation: binary.remediation ?? `Install ${binary.name}.`,
    });
  }
  if (
    diagnostics.cli.status === "missing" &&
    diagnostics.cli.required
  ) {
    issues.push({
      id: "runtime-harness-cli-missing",
      message: `${diagnostics.cli.command} is required for ${diagnostics.cli.harness} but is not on PATH`,
      remediation: diagnostics.cli.remediation ?? "Install the selected harness CLI.",
    });
  } else if (
    diagnostics.cli.status === "too-old" &&
    diagnostics.cli.required
  ) {
    issues.push({
      id: "runtime-harness-cli-old",
      message:
        `${diagnostics.cli.command} ${diagnostics.cli.version || "unknown"} is below ${diagnostics.cli.minimumVersion}`,
      remediation: diagnostics.cli.remediation ?? "Upgrade the selected harness CLI.",
    });
  }
  return issues;
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = "default";
  sections[current] = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      current = section[1].trim().replace(/^profile\s+/, "");
      sections[current] ??= {};
      continue;
    }
    const keyValue = /^([^=]+)=(.*)$/.exec(line);
    if (keyValue) {
      sections[current][keyValue[1].trim()] = keyValue[2].trim();
    }
  }
  return sections;
}

export function detectAwsCredentials(
  options: CredentialProbeOptions = {},
): AwsCredentialDiagnostics {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const sources: string[] = [];
  const profiles = new Set<string>();
  const regions = new Set<string>();
  const files: string[] = [];
  const accessKey = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  if (accessKey) sources.push("environment access keys");
  if (env.AWS_BEARER_TOKEN_BEDROCK) sources.push("AWS_BEARER_TOKEN_BEDROCK");
  const envProfile = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE;
  if (envProfile) {
    profiles.add(envProfile);
    sources.push(`environment profile ${envProfile}`);
  }
  const envRegion = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (envRegion) regions.add(envRegion);
  if (
    env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    (env.AWS_ROLE_ARN && env.AWS_ROLE_SESSION_NAME)
  ) {
    sources.push("AWS role or container credential environment");
  }
  for (const name of ["config", "credentials"] as const) {
    const path = join(home, ".aws", name);
    if (!existsSync(path)) continue;
    files.push(path);
    let sections: Record<string, Record<string, string>>;
    try {
      sections = parseIni(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    for (const [profile, values] of Object.entries(sections)) {
      profiles.add(profile);
      if (values.region) regions.add(values.region);
      if (
        values.aws_access_key_id ||
        values.sso_session ||
        values.sso_start_url ||
        values.credential_process ||
        values.role_arn
      ) {
        sources.push(`${name} profile ${profile}`);
      }
    }
  }
  const cache = join(home, ".aws", "sso", "cache");
  if (existsSync(cache)) {
    try {
      if (readdirSync(cache).some((name) => name.endsWith(".json"))) {
        sources.push("AWS SSO cache");
        files.push(cache);
      }
    } catch {
      // Unreadable cache is not positive credential evidence.
    }
  }
  return {
    hasCredentials: sources.length > 0,
    sources: [...new Set(sources)].sort(),
    profiles: [...profiles].sort(),
    regions: [...regions].sort(),
    files,
  };
}

export function requiredProviderActions(
  record: ProvidersRecord,
  harness: ModelHarness,
): ProviderPendingActionId[] {
  if (harnessOwnsModelAccess(harness)) return [];
  if (record.provider === "other") return ["non-bedrock-provider-configuration"];
  // The harness provides its own model access: nothing to write, nothing to do.
  if (record.provider === "builtin") return [];
  if (record.provider !== "amazon-bedrock") return [];
  const actions: ProviderPendingActionId[] = ["bedrock-model-access"];
  if (harness === "codex") actions.push("codex-provider-configuration");
  if (harness === "copilot") actions.push("copilot-byok-configuration");
  if (harness === "cursor") actions.push("cursor-provider-configuration");
  return actions;
}

export function reconcileProviderActions(
  record: ProvidersRecord,
  harness: ModelHarness,
  acknowledging: boolean,
): ProvidersRecord {
  const current = new Map(
    (record.pendingActions ?? []).map((action) => [action.id, action.status]),
  );
  const required = requiredProviderActions(record, harness);
  const pendingActions = required.map((id) => {
    const acknowledgeGated =
      id === "codex-provider-configuration" ||
      id === "copilot-byok-configuration" ||
      id === "cursor-provider-configuration" ||
      id === "non-bedrock-provider-configuration";
    // Only an explicit acknowledgement of this mutation can complete a newly
    // required action; a stored generic acknowledgement is not sufficient.
    return {
      id,
      status: acknowledging && record.acknowledged && acknowledgeGated
        ? "done"
        : current.get(id) ?? "pending",
    } as ProviderPendingAction;
  });
  return normalizeProvidersRecord({
    ...record,
    pendingActions,
  }) as ProvidersRecord;
}

export function pendingProviderIssues(
  record: ProvidersRecord | null,
  harness: ModelHarness,
): DiagnosticIssue[] {
  if (harnessOwnsModelAccess(harness) || !record) return [];
  return (record.pendingActions ?? [])
    .filter((action) => action.status === "pending")
    .map((action) => {
      const detail = PROVIDER_PENDING_ACTIONS[action.id as ProviderPendingActionId];
      return {
        id: action.id,
        message: detail.label,
        remediation: detail.remediation,
      };
    });
}

// The file keeps the byte order mark it had.
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, jsonFileText(value, existsSync(path) ? readFileSync(path, "utf-8") : ""));
}

function writeClaudeProvider(
  projectionRoot: string,
  harnessDir: string,
  record: ProvidersRecord,
): void {
  const settingsPath = join(projectionRoot, harnessDir, "settings.json");
  const settings = readJsonFile(settingsPath) as Record<string, unknown>;
  const env = isRecord(settings.env) ? { ...settings.env } : {};
  stripLegacyClaudeModelAliases(env);
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  env.AWS_REGION = record.region;
  if (record.profile) env.AWS_PROFILE = record.profile;
  else delete env.AWS_PROFILE;
  settings.env = env;
  writeJson(settingsPath, settings);

  const mcpPath = join(projectionRoot, ".mcp.json");
  if (!existsSync(mcpPath)) return;
  const mcp = readJsonFile(mcpPath) as Record<string, unknown>;
  if (applyMcpRegion(mcp, record.region as string)) writeJson(mcpPath, mcp);
}

// The shipped aws-mcp server's region arguments, set to `region`. False when
// the list has no such server.
function applyMcpRegion(mcp: Record<string, unknown>, region: string): boolean {
  const servers = isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
  const aws = isRecord(servers["aws-mcp"]) ? servers["aws-mcp"] : null;
  if (!aws || !Array.isArray(aws.args)) return false;
  aws.args = aws.args.map((arg) => {
    if (typeof arg !== "string") return arg;
    if (/^https:\/\/aws-mcp\.[^.]+\.api\.aws\/mcp$/.test(arg)) {
      return `https://aws-mcp.${region}.api.aws/mcp`;
    }
    if (/^AWS_REGION=/.test(arg)) return `AWS_REGION=${region}`;
    return arg;
  });
  return true;
}

// The shipped server list a copy keeps in its harness folder carries no
// provider choice; the one recorded now is applied when its servers are added.
export function withRecordedMcpRegion(mcp: Record<string, unknown>, record: ProvidersRecord | null): void {
  if (!record?.region || record.provider === "current" || record.provider === "other") return;
  applyMcpRegion(mcp, record.region);
}

const CLAUDE_BEDROCK_MODEL_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

const LEGACY_CLAUDE_BEDROCK_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_USE_BEDROCK: "1",
  AWS_REGION: "us-east-1",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "global.anthropic.claude-fable-5[1m]",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-4-8[1m]",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6[1m]",
  ANTHROPIC_DEFAULT_HAIKU_MODEL:
    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
};

export function stripLegacyClaudeModelAliases(env: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const key of CLAUDE_BEDROCK_MODEL_KEYS) {
    if (key !== "CLAUDE_CODE_USE_BEDROCK" && env[key] === LEGACY_CLAUDE_BEDROCK_ENV[key]) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

export function hasLegacyClaudeProviderConfig(
  env: Record<string, unknown>,
): boolean {
  return Object.entries(LEGACY_CLAUDE_BEDROCK_ENV).every(
    ([key, value]) => env[key] === value,
  );
}

function clearClaudeProvider(
  projectionRoot: string,
  harnessDir: string,
): void {
  const settingsPath = join(projectionRoot, harnessDir, "settings.json");
  const settings = readJsonFile(settingsPath) as Record<string, unknown>;
  const env = isRecord(settings.env) ? { ...settings.env } : {};
  const legacy = hasLegacyClaudeProviderConfig(env);
  let changed = false;
  if (legacy || env.CLAUDE_CODE_USE_BEDROCK === "1") {
    changed = stripLegacyClaudeModelAliases(env).length > 0;
  }
  if (legacy) {
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.AWS_REGION;
    changed = true;
  }
  if (!changed) return;
  settings.env = env;
  writeJson(settingsPath, settings);
}

const LEGACY_CODEX_BEDROCK_COMMENT =
  /^(?:# Model: these session defaults are what judgment-tier agent roles inherit\r?\n# \(their TOMLs omit model\/model_reasoning_effort by design - see the tier\r?\n# projection\); balanced roles pin gpt-5\.6-terra\/medium, while templated roles inherit\.\r?\n)?# D-9: Amazon Bedrock is the shipped default provider \(web_search is\r?\n# unavailable there; the market-research stage degrades gracefully\)\. For\r?\n# OpenAI-auth setups, comment out model_provider and the \[model_providers\]\r?\n# block\.\r?\n/m;

const LEGACY_CODEX_MODEL_PROVIDER = /^(#[ \t]?)?model_provider\s*=\s*"amazon-bedrock"\s*$/m;

function legacyCodexAwsTablePattern(profile: string, region: string, commented = false): RegExp {
  const escapedProfile = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRegion = region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = commented ? "#[ \\t]?" : "";
  return new RegExp(
    `^${prefix}\\[model_providers\\.amazon-bedrock\\.aws\\]\\r?\\n` +
      `(?:${prefix}# Set to your AWS profile/region with Bedrock model access\\.\\r?\\n)?` +
      `${prefix}profile = "${escapedProfile}"\\r?\\n${prefix}region = "${escapedRegion}"` +
      `(?:\\r?\\n(?:\\r?\\n)?|(?![\\s\\S]))`,
    "m",
  );
}

const LEGACY_CODEX_AWS_TABLE = legacyCodexAwsTablePattern("default", "us-east-1");
const LEGACY_CODEX_COMMENTED_AWS_TABLE = legacyCodexAwsTablePattern("default", "us-east-1", true);

function clearCodexProvider(
  projectionRoot: string,
  harnessDir: string,
  previousProvider: ProvidersRecord | null,
): void {
  const path = join(projectionRoot, harnessDir, "config.toml");
  const original = readFileSync(path, "utf-8");
  if (!hasLegacyCodexProviderConfig(original, previousProvider)) return;
  let content = original;
  content = content.replace(LEGACY_CODEX_BEDROCK_COMMENT, "");
  content = content.replace(
    /^model\s*=\s*"openai\.gpt-5\.5"\s*(?:\r?\n|$)/m,
    "",
  );
  content = content.replace(
    /^(?:#[ \t]?)?model_provider\s*=\s*"amazon-bedrock"\s*(?:\r?\n|$)/m,
    "",
  );
  content = content.replace(
    /^model_context_window\s*=\s*1000000\s*(?:\r?\n|$)/m,
    "",
  );
  content = content.replace(
    /^model_reasoning_effort\s*=\s*"high"\s*(?:\r?\n|$)/m,
    "",
  );
  // Remove only the exact shipped or previously written table and its separator.
  const commented = !!LEGACY_CODEX_MODEL_PROVIDER.exec(original)?.[1];
  const shippedTable = commented ? LEGACY_CODEX_COMMENTED_AWS_TABLE : LEGACY_CODEX_AWS_TABLE;
  if (shippedTable.test(original)) {
    content = content.replace(shippedTable, "");
  } else if (previousProvider?.provider === "amazon-bedrock" && previousProvider.region) {
    content = content.replace(
      legacyCodexAwsTablePattern(previousProvider.profile ?? "default", previousProvider.region, commented),
      "",
    );
  }
  writeFileSync(path, content.replace(/\n{3,}/g, "\n\n"));
}

export function hasLegacyCodexProviderConfig(
  content: string,
  previousProvider: ProvidersRecord | null = null,
): boolean {
  const provider = LEGACY_CODEX_MODEL_PROVIDER.exec(content);
  if (
    !LEGACY_CODEX_BEDROCK_COMMENT.test(content) ||
    !/^model\s*=\s*"openai\.gpt-5\.5"\s*$/m.test(content) ||
    !provider ||
    !/^model_context_window\s*=\s*1000000\s*$/m.test(content) ||
    !/^model_reasoning_effort\s*=\s*"high"\s*$/m.test(content)
  ) return false;
  // The provider line and every table line must all be active or all commented.
  const commented = !!provider[1];
  const shippedTable = commented ? LEGACY_CODEX_COMMENTED_AWS_TABLE : LEGACY_CODEX_AWS_TABLE;
  const table = shippedTable.exec(content) ?? (
    previousProvider?.provider === "amazon-bedrock" && previousProvider.region
      ? legacyCodexAwsTablePattern(previousProvider.profile ?? "default", previousProvider.region, commented).exec(content)
      : null
  );
  if (!table) return false;
  // A TOML table continues across blank lines and comments until the next header.
  let inCommentedBody = commented;
  for (const line of content.slice(table.index + table[0].length).split(/\r?\n/)) {
    if (line.startsWith("[")) return true;
    if (inCommentedBody) {
      if (/^#[ \t]?(?:profile|region)\s*=/.test(line)) return false;
      // An ordinary comment ends the commented body; later active keys are
      // still foreign until the next real TOML header, just as for active tables.
      if (/^\s*#/.test(line)) inCommentedBody = false;
    }
    if (!/^\s*(?:#.*)?$/.test(line)) return false;
  }
  return true;
}

// The `aws-mcp` region in `.kiro/settings/mcp.json` is plain MCP configuration.
// Kiro CLI no longer asks a provider question, so no record drives it; but every
// refresh restages that file from the release bytes, which would silently move a
// region the project already carries (set by an earlier build's Bedrock answer,
// or by hand) back to the shipped one. Carry the project's current endpoint
// region and `AWS_REGION` metadata into the staged file instead, so the staged
// bytes equal the current bytes and the refresh preserves the file. Reads only
// the two aws-mcp arguments; everything else comes from the release.
export function preserveKiroMcpRegion(
  projectDir: string,
  stagedRoot: string,
  harnessDir: string,
): void {
  const relative = join(harnessDir, "settings", "mcp.json");
  const currentPath = join(projectDir, relative);
  const stagedPath = join(stagedRoot, relative);
  if (!existsSync(currentPath) || !existsSync(stagedPath)) return;
  const awsArgs = (path: string): { value: Record<string, unknown>; args: unknown[] } | null => {
    let value: Record<string, unknown>;
    try {
      value = readJsonFile(path) as Record<string, unknown>;
    } catch {
      return null;
    }
    const servers = isRecord(value.mcpServers) ? value.mcpServers : {};
    const aws = isRecord(servers["aws-mcp"]) ? servers["aws-mcp"] : null;
    return aws && Array.isArray(aws.args) ? { value, args: aws.args } : null;
  };
  const current = awsArgs(currentPath);
  const staged = awsArgs(stagedPath);
  if (!current || !staged) return;
  const endpoint = current.args.find((arg): arg is string =>
    typeof arg === "string" && /^https:\/\/aws-mcp\.[^.]+\.api\.aws\/mcp$/.test(arg)
  );
  const metadata = current.args.find((arg): arg is string =>
    typeof arg === "string" && /^AWS_REGION=/.test(arg)
  );
  if (!endpoint && !metadata) return;
  const servers = staged.value.mcpServers as Record<string, unknown>;
  const aws = servers["aws-mcp"] as Record<string, unknown>;
  aws.args = staged.args.map((arg) => {
    if (typeof arg !== "string") return arg;
    if (endpoint && /^https:\/\/aws-mcp\.[^.]+\.api\.aws\/mcp$/.test(arg)) return endpoint;
    if (metadata && /^AWS_REGION=/.test(arg)) return metadata;
    return arg;
  });
  // When the region was the only difference, stage the project's exact bytes so
  // the refresh sees an identical file and preserves it, whatever its
  // formatting. Otherwise the release changed the file elsewhere and the staged
  // copy carries the preserved region in canonical form.
  const currentText = readFileSync(currentPath, "utf-8");
  if (JSON.stringify(current.value) === JSON.stringify(staged.value)) {
    writeFileSync(stagedPath, currentText);
    return;
  }
  writeJson(stagedPath, staged.value);
}


// A staged opencode.json as plain JSON, or null when it is the team's own file
// with comments (a copy's own tree), which holds no provider block AI-DLC
// writes or clears here.
function openCodeJsonOrNull(path: string): Record<string, unknown> | null {
  try {
    const value = readJsonFile(path);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function writeOpenCodeProvider(
  projectionRoot: string,
  record: ProvidersRecord,
): void {
  if (!record.opencodeDefault) return;
  const path = join(projectionRoot, "opencode.json");
  const value = openCodeJsonOrNull(path);
  if (value === null) return;
  const providers = isRecord(value.provider) ? { ...value.provider } : {};
  const existing = isRecord(providers["amazon-bedrock"])
    ? providers["amazon-bedrock"]
    : {};
  providers["amazon-bedrock"] = {
    ...existing,
    options: {
      ...(isRecord(existing.options) ? existing.options : {}),
      region: record.region,
      ...(record.profile ? { profile: record.profile } : {}),
    },
  };
  value.provider = providers;
  writeJson(path, value);
}

function openCodeProviderMatchesRecord(
  value: unknown,
  record: ProvidersRecord | null,
): boolean {
  if (
    record?.provider !== "amazon-bedrock" ||
    record.opencodeDefault !== true ||
    !isRecord(value)
  ) {
    return false;
  }
  const options = isRecord(value.options) ? value.options : {};
  return (
    options.region === record.region &&
    (
      record.profile
        ? options.profile === record.profile
        : !Object.hasOwn(options, "profile")
    )
  );
}

function clearOpenCodeProvider(
  projectionRoot: string,
  previousProvider: ProvidersRecord | null,
): void {
  const path = join(projectionRoot, "opencode.json");
  if (!existsSync(path)) return;
  const value = openCodeJsonOrNull(path);
  if (value === null || !isRecord(value.provider)) return;
  const providers = { ...value.provider };
  if (!openCodeProviderMatchesRecord(
    providers["amazon-bedrock"],
    previousProvider,
  )) {
    return;
  }
  const provider = providers["amazon-bedrock"] as Record<string, unknown>;
  const options = isRecord(provider.options) ? provider.options : {};
  delete options.region;
  if (previousProvider?.profile) delete options.profile;
  if (Object.keys(options).length > 0) provider.options = options;
  else delete provider.options;
  if (Object.keys(provider).length === 0) delete providers["amazon-bedrock"];
  if (Object.keys(providers).length > 0) value.provider = providers;
  else delete value.provider;
  writeJson(path, value);
}

function writeClaudeFlags(
  projectionRoot: string,
  harnessDir: string,
  record: ProjectFlagsRecord,
): void {
  if (!record.defaultScope) return;
  const path = join(projectionRoot, harnessDir, "settings.json");
  const value = readJsonFile(path) as Record<string, unknown>;
  const env = isRecord(value.env) ? { ...value.env } : {};
  env.AWS_AIDLC_DEFAULT_SCOPE = record.defaultScope;
  value.env = env;
  writeJson(path, value);
}

export function applyProjectFlagsToProjection(
  projectionRoot: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProjectFlagsRecord | null,
): void {
  if (record && harness === "claude") {
    writeClaudeFlags(projectionRoot, harnessDir, record);
  }
}

export function applyConfigDiagnosticRecords(
  projectionRoot: string,
  harnessDir: string,
  harness: ModelHarness,
  records: ConfigDiagnosticRecords,
  previousProvider: ProvidersRecord | null = null,
): void {
  // Owned harnesses record no provider answer; a legacy record is not applied
  // anywhere. The Kiro CLI MCP region is carried by preserveKiroMcpRegion from
  // the project's own file during staging, not from a record.
  if (harnessOwnsModelAccess(harness)) return;
  const provider = records.providers;
  if (!provider?.provider) {
    if (harness === "claude") clearClaudeProvider(projectionRoot, harnessDir);
    else if (harness === "codex") clearCodexProvider(projectionRoot, harnessDir, previousProvider);
    else if (harness === "opencode") {
      clearOpenCodeProvider(projectionRoot, previousProvider);
    }
    return;
  }
  if (provider.provider === "current" || provider.provider === "other") {
    if (harness === "claude") clearClaudeProvider(projectionRoot, harnessDir);
    else if (harness === "codex") clearCodexProvider(projectionRoot, harnessDir, previousProvider);
    else if (harness === "opencode") {
      clearOpenCodeProvider(projectionRoot, previousProvider);
    }
    return;
  }
  if (
    harness === "opencode" && provider.provider === "amazon-bedrock" &&
    provider.opencodeDefault === false
  ) {
    clearOpenCodeProvider(projectionRoot, previousProvider);
    return;
  }
  if (!provider.region) return;
  if (harness === "claude") {
    writeClaudeProvider(projectionRoot, harnessDir, provider);
  } else if (harness === "opencode") {
    writeOpenCodeProvider(projectionRoot, provider);
  }
}

export function providerFiles(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProvidersRecord | null,
): DiagnosticFileSetting[] {
  const harnessData = join(harnessDir, "tools", "data", "harness.json");
  const files: DiagnosticFileSetting[] = [{
    setting: "provider answers and pending actions",
    file: harnessData,
  }];
  if (harnessOwnsModelAccess(harness)) return files.map((entry) => ({
    ...entry,
    file: resolve(projectDir, entry.file),
  }));
  if (record?.provider === "current" || record?.provider === "other") {
    if (harness === "claude") {
      files.push({
        setting: "Claude project environment",
        file: join(harnessDir, "settings.json"),
      });
    } else if (harness === "codex") {
      files.push({
        setting: "Codex project configuration",
        file: join(harnessDir, "config.toml"),
      });
    } else if (harness === "opencode") {
      files.push({
        setting: "opencode project configuration",
        file: "opencode.json",
      });
    }
    return files.map((entry) => ({
      ...entry,
      file: resolve(projectDir, entry.file),
    }));
  }
  if (record?.provider !== "amazon-bedrock") return files;
  if (harness === "claude") {
    files.push({
      setting: "AWS region and profile",
      file: join(harnessDir, "settings.json"),
    });
    if (existsSync(join(projectDir, ".mcp.json"))) {
      files.push({
        setting: "AWS MCP region endpoint and metadata",
        file: ".mcp.json",
      });
    }
  } else if (harness === "opencode" && record.opencodeDefault) {
    files.push({
      setting: "amazon-bedrock provider options",
      file: "opencode.json",
    });
  }
  return files.map((entry) => ({
    ...entry,
    file: resolve(projectDir, entry.file),
  }));
}

export function availableScopeNames(harnessRoot: string): string[] {
  const root = join(harnessRoot, "scopes");
  if (!existsSync(root)) return [];
  const names = new Set<string>();
  for (const file of readdirSync(root).filter((name) => name.endsWith(".md")).sort()) {
    const path = join(root, file);
    let content = "";
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    const name = frontmatter ? /^name:\s*([a-z][a-z0-9-]*)\s*$/m.exec(frontmatter)?.[1] : null;
    if (name) names.add(name);
  }
  return [...names].sort();
}

const FLAG_ENV_FIELDS: Array<{
  env: string;
  field: keyof ProjectFlagsRecord;
}> = [
  { env: "AWS_AIDLC_DEFAULT_SCOPE", field: "defaultScope" },
  { env: "AIDLC_USE_SWARM", field: "swarm" },
  { env: "AIDLC_HOOK_DEBUG", field: "hookDebug" },
  { env: "AIDLC_SENSOR_TIMEOUT_MS", field: "sensorTimeoutMs" },
  { env: "AIDLC_QUESTION_RETENTION_DAYS", field: "questionRetentionDays" },
];

export function recordedFlagValue(
  record: ProjectFlagsRecord,
  envName: string,
): string | undefined {
  if (
    (RECORDABLE_PROJECT_BYPASSES as readonly string[]).includes(envName)
  ) {
    return record.bypasses?.includes(
      envName as (typeof RECORDABLE_PROJECT_BYPASSES)[number],
    )
      ? "1"
      : undefined;
  }
  const field = FLAG_ENV_FIELDS.find((item) => item.env === envName)?.field;
  const value = field ? record[field] : undefined;
  if (typeof value === "boolean") return value ? "1" : "";
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : undefined;
}

export function effectiveProjectFlagValues(
  record: ProjectFlagsRecord | null,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const names = [
    ...FLAG_ENV_FIELDS.map((item) => item.env),
    ...RECORDABLE_PROJECT_BYPASSES,
  ];
  return Object.fromEntries(names.map((name) => [
    name,
    Object.hasOwn(env, name)
      ? env[name]
      : record
      ? recordedFlagValue(record, name)
      : undefined,
  ]));
}

export function flagFiles(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProjectFlagsRecord | null,
  resolved: ResolvedAidlcSettings = resolveAidlcSettings(projectDir),
): DiagnosticFileSetting[] {
  const files: DiagnosticFileSetting[] = [];
  for (const [layer, info] of Object.entries(resolved.files)) {
    if (!info.present) continue;
    const target = layer === "machine" ? "global" : layer;
    if (!readSettingsTarget(projectDir, target as "global" | "project" | "local")?.flags) {
      continue;
    }
    files.push({
      setting: `${layer} flag policy`,
      file: layer === "machine"
        ? info.path
        : relative(projectDir, info.path).replaceAll("\\", "/") || info.path,
    });
  }
  if (record?.defaultScope && harness === "claude") {
    files.push({
      setting: "AWS_AIDLC_DEFAULT_SCOPE session environment",
      file: join(projectDir, harnessDir, "settings.json"),
    });
  }
  return files;
}

export function flagIssues(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProjectFlagsRecord | null,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticIssue[] {
  if (!record) return [];
  const issues: DiagnosticIssue[] = [];
  for (const envName of [
    ...FLAG_ENV_FIELDS.map((item) => item.env),
    ...RECORDABLE_PROJECT_BYPASSES,
  ]) {
    const recorded = recordedFlagValue(record, envName);
    if (
      recorded !== undefined &&
      Object.hasOwn(env, envName) &&
      env[envName] !== recorded
    ) {
      issues.push({
        id: `flag-env-override-${envName.toLowerCase().replaceAll("_", "-")}`,
        message:
          `${envName}=${JSON.stringify(env[envName])} overrides the recorded answer ${
            envName === "AIDLC_USE_SWARM" || envName === "AIDLC_HOOK_DEBUG"
              ? record[
                  envName === "AIDLC_USE_SWARM" ? "swarm" : "hookDebug"
                ] === true
                ? "on"
                : "off"
              : JSON.stringify(recorded)
          }`,
        remediation:
          `Unset ${envName} to use the recorded project answer, or update the record to match the intended environment override.`,
      });
    }
  }
  if (record.defaultScope && harness === "claude") {
    const path = join(projectDir, harnessDir, "settings.json");
    try {
      const value = readJsonFile(path) as Record<string, unknown>;
      const settingsEnv = isRecord(value.env) ? value.env : {};
      if (settingsEnv.AWS_AIDLC_DEFAULT_SCOPE !== record.defaultScope) {
        issues.push({
          id: "flag-claude-default-scope-drift",
          message: `${path} does not carry the recorded default scope ${record.defaultScope}`,
          remediation: "Run aidlc config flags again to reapply the recorded default scope.",
        });
      }
    } catch (error) {
      issues.push({
        id: "flag-claude-settings-unreadable",
        message: error instanceof Error ? error.message : String(error),
        remediation: "Restore .claude/settings.json, then rerun aidlc config flags.",
      });
    }
  }
  return issues;
}

function collectPluginNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPluginNames(item, names);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.plugin === "string" && /^[a-z][a-z0-9-]*$/.test(value.plugin)) {
    names.add(value.plugin);
  }
  for (const child of Object.values(value)) collectPluginNames(child, names);
}

export function composedPluginNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dataDir).sort()) {
    const match = /^(?:plugin-contrib|plugin-owned|plugin-compose)-([a-z][a-z0-9-]*)\.json$/
      .exec(file);
    if (match) names.push(match[1]);
  }
  return names;
}

export function discoverInstalledPluginNames(
  projectDir: string,
  harnessDir: string,
): string[] {
  const names = new Set<string>(["aidlc"]);
  const dataDir = join(projectDir, harnessDir, "tools", "data");
  for (const name of composedPluginNames(dataDir)) names.add(name);
  if (existsSync(dataDir)) {
    const graphPath = join(dataDir, "stage-graph.json");
    if (existsSync(graphPath)) {
      try {
        collectPluginNames(readJsonFile(graphPath), names);
      } catch {
        // Sidecars and scope files remain available when the graph is stale.
      }
    }
  }
  const scopesDir = join(projectDir, harnessDir, "scopes");
  if (existsSync(scopesDir)) {
    for (const file of readdirSync(scopesDir).filter((name) => name.endsWith(".md"))) {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/
        .exec(readFileSync(join(scopesDir, file), "utf-8"))?.[1] ?? "";
      const plugin = /^plugin:\s*([a-z][a-z0-9-]*)\s*$/m.exec(frontmatter)?.[1];
      if (plugin) names.add(plugin);
    }
  }
  return [...names].sort();
}

export function readPluginSelection(harnessRoot: string): string[] | null {
  const path = join(harnessRoot, "tools", "data", "harness.json");
  const value = readJsonFile(path) as Record<string, unknown>;
  if (!Object.hasOwn(value, "plugins")) return null;
  if (
    !Array.isArray(value.plugins) ||
    value.plugins.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${path}: plugins must be an array of non-empty strings`);
  }
  return [...new Set(value.plugins as string[])].sort();
}

export function completionInstruction(
  projectDir: string,
  harnessDir: string,
  shell: Exclude<CompletionShell, "none">,
): string {
  const usesBun = runtimeCommandFiles(projectDir, harnessDir).some((file) => {
    if (file.replaceAll("\\", "/").includes("/skills/")) return false;
    try {
      return readFileSync(file, "utf-8").includes(`bun ${harnessDir}/tools/aidlc.ts`);
    } catch {
      return false;
    }
  });
  const invoke = usesBun ? `bun ${harnessDir}/tools/aidlc.ts` : "aidlc";
  if (shell === "fish") {
    return `${invoke} system completions fish | source`;
  }
  if (shell === "powershell") {
    return `${invoke} system completions powershell | Out-String | Invoke-Expression`;
  }
  return `eval "$(${invoke} system completions ${shell})"`;
}

const SHIPPED_MCP_SERVERS = [
  "aws-iac",
  "aws-mcp",
  "aws-pricing",
  "aws-serverless",
  "context7",
] as const;

export function projectChoiceFiles(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
): DiagnosticFileSetting[] {
  const files: DiagnosticFileSetting[] = [{
    setting: "plugin selection, MCP consent, and completion answer",
    file: join(projectDir, harnessDir, "tools", "data", "harness.json"),
  }];
  const surface = projectMcpSurface(projectDir, harnessDir, harness);
  if (surface.path && existsSync(surface.path)) {
    files.push({
      setting: surface.kind === "claude"
        ? "consent-managed MCP server entries"
        : "always-shipped MCP server configuration",
      file: surface.path,
    });
  }
  return files;
}

type ProjectMcpSurface = {
  kind: "claude" | "always" | "none";
  path?: string;
};

function projectMcpSurface(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
): ProjectMcpSurface {
  if (harness === "claude") {
    return { kind: "claude", path: join(projectDir, ".mcp.json") };
  }
  if (harness === "kiro") {
    return {
      kind: "always",
      path: join(projectDir, harnessDir, "settings", "mcp.json"),
    };
  }
  if (harness === "cursor") {
    const path = join(projectDir, harnessDir, "mcp.json");
    return existsSync(path) ? { kind: "always", path } : { kind: "none" };
  }
  return { kind: "none" };
}

export function projectMcpNote(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProjectChoicesRecord | null,
): string | null {
  if (!record?.mcp) return null;
  const surface = projectMcpSurface(projectDir, harnessDir, harness);
  if (surface.kind === "always" && record.mcp === "none") {
    return `${harness} ships ${surface.path} as a framework file; MCP none is an instruct-only preference and does not remove that file.`;
  }
  if (surface.kind === "none") {
    return `${harness} has no shipped MCP surface; the recorded ${record.mcp} answer is informational.`;
  }
  return null;
}

export function projectChoiceIssues(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProjectChoicesRecord | null,
  plugins: string[] | null,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const known = new Set(discoverInstalledPluginNames(projectDir, harnessDir));
  for (const plugin of plugins ?? []) {
    if (!known.has(plugin)) {
      issues.push({
        id: "project-plugin-unknown",
        message: `Recorded plugin ${plugin} is not installed`,
        remediation: "Install the plugin or rerun aidlc config project with the installed plugin set.",
      });
    }
  }
  if (!record?.mcp) return issues;
  const surface = projectMcpSurface(projectDir, harnessDir, harness);
  if (surface.kind === "none") return issues;
  if (surface.kind === "always" && record.mcp === "none") return issues;
  const path = surface.path as string;
  let servers = new Set<string>();
  if (existsSync(path)) {
    try {
      const value = readJsonFile(path) as Record<string, unknown>;
      servers = new Set(
        isRecord(value.mcpServers) ? Object.keys(value.mcpServers) : [],
      );
    } catch {
      issues.push({
        id: "project-mcp-unreadable",
        message: `${path} is malformed`,
        remediation: "Repair .mcp.json, then rerun aidlc config project.",
      });
      return issues;
    }
  }
  if (
    record.mcp === "defaults" &&
    SHIPPED_MCP_SERVERS.some((name) => !servers.has(name))
  ) {
    issues.push({
      id: "project-mcp-defaults-drift",
      message: "Recorded MCP consent is defaults, but one or more shipped MCP entries are absent",
      remediation: "Run aidlc config project --mcp defaults to reapply consented entries.",
    });
  }
  if (
    surface.kind === "claude" &&
    record.mcp === "none" &&
    SHIPPED_MCP_SERVERS.some((name) => servers.has(name))
  ) {
    issues.push({
      id: "project-mcp-none-drift",
      message: "Recorded MCP consent is none, but shipped MCP entries remain",
      remediation: "Run aidlc config project --mcp none to remove framework-owned MCP entries.",
    });
  }
  return issues;
}

export function providerSurfaceIssues(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProvidersRecord,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const mismatch = (id: string, file: string, message: string): void => {
    issues.push({
      id,
      message,
      remediation: `Run aidlc config providers again to reapply the recorded answer to ${file}.`,
    });
  };
  const warning = (id: string, message: string, remediation: string): void => {
    issues.push({ id, message, remediation, severity: "warn" });
  };
  try {
    if (record.provider === "current" || record.provider === "other") {
      if (harness === "claude") {
        const path = join(projectDir, harnessDir, "settings.json");
        const value = readJsonFile(path) as Record<string, unknown>;
        const env = isRecord(value.env) ? value.env : {};
        if (hasLegacyClaudeProviderConfig(env)) {
          mismatch(
            "provider-claude-project-override",
            path,
            "Claude settings still carry the legacy AI-DLC Bedrock defaults",
          );
        } else if (env.CLAUDE_CODE_USE_BEDROCK === "1") {
          const projectOverrides = ["CLAUDE_CODE_USE_BEDROCK"];
          for (const key of ["AWS_REGION", "AWS_PROFILE"]) {
            if (Object.hasOwn(env, key)) projectOverrides.push(key);
          }
          warning(
            "provider-claude-project-override",
            `Claude project settings enable Bedrock despite the recorded ${record.provider} choice with: ${projectOverrides.join(", ")}`,
            `Review ${path}. Leave the entries in place if the project override is intentional.`,
          );
        }
        const localPath = join(projectDir, harnessDir, "settings.local.json");
        if (existsSync(localPath)) {
          const local = readJsonFile(localPath) as Record<string, unknown>;
          const localEnv = isRecord(local.env) ? local.env : {};
          const localOverrides: string[] = CLAUDE_BEDROCK_MODEL_KEYS.filter(
            (key) => Object.hasOwn(localEnv, key),
          );
          if (localOverrides.length > 0) {
            for (const key of ["AWS_REGION", "AWS_PROFILE"]) {
              if (Object.hasOwn(localEnv, key)) localOverrides.push(key);
            }
            warning(
              "provider-claude-local-override",
              `Claude local settings override the recorded project choice with: ${localOverrides.join(", ")}`,
              `Review ${localPath}. Leave the entries in place if the personal override is intentional.`,
            );
          }
        }
      } else if (harness === "codex") {
        const path = join(projectDir, harnessDir, "config.toml");
        const text = readFileSync(path, "utf-8");
        if (hasLegacyCodexProviderConfig(text)) {
          mismatch(
            "provider-codex-project-override",
            path,
            "Codex project configuration still contains the legacy AI-DLC Bedrock defaults",
          );
        } else {
          const entries: string[] = [];
          if (/^model_provider\s*=\s*"amazon-bedrock"\s*$/m.test(text)) {
            entries.push("model_provider");
          }
          // Report a fixed identifier, never the project-authored header text:
          // diagnostics are read by agents and must not relay file content.
          if (/^\[model_providers\.amazon-bedrock[^\]]*\]\s*$/m.test(text)) {
            entries.push("[model_providers.amazon-bedrock] table");
          }
          if (/^model\s*=\s*"openai\.gpt-5\.5"\s*$/m.test(text)) {
            entries.push("legacy shipped model pin");
          }
          if (/^model_context_window\s*=\s*1000000\s*$/m.test(text)) {
            entries.push("legacy shipped context-window pin");
          }
          if (/^#[ \t]*model_provider\s*=\s*"amazon-bedrock"\s*$/m.test(text)) {
            entries.push("commented model_provider");
          }
          if (/^#[ \t]*\[model_providers\.amazon-bedrock[^\]]*\]\s*$/m.test(text)) {
            entries.push("commented [model_providers.amazon-bedrock] table");
          }
          if (entries.length > 0) {
            warning(
              "provider-codex-project-override",
              `Codex project configuration still names the amazon-bedrock provider despite the recorded ${record.provider} choice with: ${entries.join(", ")}`,
              `AI-DLC removes only the exact shipped Bedrock block. Review ${path} and remove the entries, or leave them in place if the project override is intentional.`,
            );
          }
        }
      } else if (harness === "opencode" && record.provider === "other") {
        const path = join(projectDir, "opencode.json");
        const value = readTeamJsonFile(path) as Record<string, unknown>;
        const providers = isRecord(value.provider) ? value.provider : {};
        if (Object.hasOwn(providers, "amazon-bedrock")) {
          warning(
            "provider-opencode-project-override",
            "opencode project configuration still defines an amazon-bedrock provider despite the recorded other choice",
            `Review ${path}. Leave the provider in place if the multi-provider configuration is intentional.`,
          );
        }
      }
      return issues;
    }
    if (record.provider !== "amazon-bedrock" || !record.region) return issues;
    if (harness === "codex") {
      warning(
        "provider-codex-self-attested",
        "Codex provider setup is self-attested because AI-DLC cannot resolve the effective user configuration or alternate credential channels",
        PROVIDER_PENDING_ACTIONS["codex-provider-configuration"].remediation,
      );
    } else if (harness === "claude") {
      const settingsPath = join(projectDir, harnessDir, "settings.json");
      const settings = readJsonFile(settingsPath) as Record<string, unknown>;
      const env = isRecord(settings.env) ? settings.env : {};
      if (
        env.CLAUDE_CODE_USE_BEDROCK !== "1" ||
        env.AWS_REGION !== record.region ||
        (record.profile && env.AWS_PROFILE !== record.profile)
      ) {
        mismatch("provider-claude-settings", settingsPath, "Claude settings do not enable Bedrock with the recorded AWS region/profile");
      }
      const localPath = join(projectDir, harnessDir, "settings.local.json");
      if (existsSync(localPath)) {
        const local = readJsonFile(localPath) as Record<string, unknown>;
        const localEnv = isRecord(local.env) ? local.env : {};
        const conflicts = [
          ...(Object.hasOwn(localEnv, "CLAUDE_CODE_USE_BEDROCK") &&
              localEnv.CLAUDE_CODE_USE_BEDROCK !== "1"
            ? ["CLAUDE_CODE_USE_BEDROCK"]
            : []),
          ...(Object.hasOwn(localEnv, "AWS_REGION") &&
              localEnv.AWS_REGION !== record.region
            ? ["AWS_REGION"]
            : []),
          ...(record.profile &&
              Object.hasOwn(localEnv, "AWS_PROFILE") &&
              localEnv.AWS_PROFILE !== record.profile
            ? ["AWS_PROFILE"]
            : []),
        ];
        if (conflicts.length > 0) {
          mismatch(
            "provider-claude-local-override",
            localPath,
            `Claude local settings override the recorded Bedrock choice with: ${conflicts.join(", ")}`,
          );
        }
      }
      const mcpPath = join(projectDir, ".mcp.json");
      if (existsSync(mcpPath)) {
        const text = readFileSync(mcpPath, "utf-8");
        if (
          !text.includes(`https://aws-mcp.${record.region}.api.aws/mcp`) ||
          !text.includes(`AWS_REGION=${record.region}`)
        ) {
          mismatch("provider-claude-mcp", mcpPath, "Claude AWS MCP settings do not reflect the recorded region");
        }
      }
    } else if (harness === "opencode" && record.opencodeDefault) {
      const path = join(projectDir, "opencode.json");
      const value = readTeamJsonFile(path) as Record<string, unknown>;
      const providers = isRecord(value.provider) ? value.provider : {};
      const bedrock = isRecord(providers["amazon-bedrock"]) ? providers["amazon-bedrock"] : {};
      const options = isRecord(bedrock.options) ? bedrock.options : {};
      if (options.region !== record.region || (record.profile && options.profile !== record.profile)) {
        mismatch("provider-opencode", path, "OpenCode Bedrock provider options do not reflect the recorded region/profile");
      }
    }
  } catch (error) {
    issues.push({
      id: "provider-surface-unreadable",
      message: error instanceof Error ? error.message : String(error),
      remediation: "Restore the selected harness configuration files, then rerun aidlc config providers.",
    });
  }
  return issues;
}

export function providerIssues(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProvidersRecord | null,
  credentials: AwsCredentialDiagnostics = detectAwsCredentials(),
): DiagnosticIssue[] {
  if (harnessOwnsModelAccess(harness) || !record) return [];
  const issues = [
    ...pendingProviderIssues(record, harness),
    ...providerSurfaceIssues(projectDir, harnessDir, harness, record),
  ];
  if (record.provider === "amazon-bedrock" && !credentials.hasCredentials) {
    issues.push({
      id: "provider-credentials-missing",
      message: "No AWS credential source was found in the offline environment, profile files, or SSO cache",
      remediation:
        "Configure AWS access keys, AWS_PROFILE, an AWS role credential source, or AWS SSO locally. This check never calls AWS.",
    });
  }
  return issues;
}

// The Copilot CLI keeps folder trust in config.json under COPILOT_HOME, else
// <home>/.copilot, and finds home the way Node does: USERPROFILE on Windows,
// HOME elsewhere. A Windows desktop process usually has no HOME at all, and a
// HOME that is set (a network drive, say) is not where the CLI looks.
export function copilotConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = hostPlatform(),
): string {
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  return join(env.COPILOT_HOME || join(home, ".copilot"), "config.json");
}

// True when a trustedFolders entry covers the project the way the CLI judges
// it: the folder itself or any folder above it, after resolving links and
// dropping trailing separators. On Windows the CLI also ignores case and
// separator style, so `c:/work` covers `C:\work\app` there.
export function copilotFolderTrusted(
  projectDir: string,
  trustedFolders: readonly unknown[],
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  const windows = platform === "win32";
  const separator = windows ? "\\" : "/";
  const norm = (path: string): string => {
    let out = path;
    try {
      out = realpathSync(path);
    } catch {
      // keep the recorded form; a recorded-but-deleted path never matches
    }
    if (windows) out = out.replaceAll("/", "\\").toLowerCase();
    return out.replace(/[/\\]+$/, "");
  };
  const project = norm(projectDir);
  return trustedFolders.some((entry) => {
    if (typeof entry !== "string" || entry === "") return false;
    const folder = norm(entry);
    return project === folder || project.startsWith(`${folder}${separator}`);
  });
}

// The list the CLI reads: trustedFolders, or the older trusted_folders it
// still honours. With both present the later one in the file wins.
export function copilotTrustedFolderKey(
  config: Record<string, unknown>,
): "trustedFolders" | "trusted_folders" {
  const last = Object.keys(config).findLast((key) =>
    key === "trustedFolders" || key === "trusted_folders"
  );
  return last === "trusted_folders" ? "trusted_folders" : "trustedFolders";
}

export type CopilotCliTrust =
  | { state: "absent" | "unreadable"; configPath: string }
  | {
      state: "trusted" | "untrusted";
      configPath: string;
      raw: string;
      config: Record<string, unknown>;
    };

// What the Copilot CLI's config says about this folder. Absent means no CLI
// config at all (a VS Code-only install; the CLI asks on its first run).
// Unreadable covers bad JSON and a trusted-folders value that is not a list,
// which the CLI ignores.
export function copilotCliTrust(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = hostPlatform(),
): CopilotCliTrust {
  const configPath = copilotConfigPath(env, platform);
  if (!existsSync(configPath)) return { state: "absent", configPath };
  let raw: string;
  let config: unknown;
  try {
    raw = readFileSync(configPath, "utf-8");
    config = Bun.JSONC.parse(raw);
  } catch {
    return { state: "unreadable", configPath };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { state: "unreadable", configPath };
  }
  const record = config as Record<string, unknown>;
  const list = record[copilotTrustedFolderKey(record)];
  if (list !== undefined && !Array.isArray(list)) return { state: "unreadable", configPath };
  return {
    state: copilotFolderTrusted(projectDir, Array.isArray(list) ? list : [], platform)
      ? "trusted"
      : "untrusted",
    configPath,
    raw,
    config: record,
  };
}

// The setup check's view of Copilot CLI folder trust. Untrusted is a warning
// for the same reason as in doctor: VS Code never reads this list and the
// interactive CLI asks first; only headless `copilot -p` runs skip silently.
export function copilotTrustIssues(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticIssue[] {
  const trust = copilotCliTrust(projectDir, env);
  if (trust.state === "unreadable") {
    return [{
      id: "copilot-cli-config-unreadable",
      message: `${trust.configPath} is not a Copilot CLI config AI-DLC can read, so the CLI's folder trust is unknown`,
      remediation: `Repair ${trust.configPath}: valid JSON (comments are allowed) with trustedFolders as a list, then rerun the setup check.`,
    }];
  }
  if (trust.state !== "untrusted") return [];
  return [{
    id: "copilot-folder-untrusted",
    message: "Copilot CLI has not trusted this folder",
    remediation:
      `Run copilot in this folder once and choose "Yes, and remember this folder for future sessions", or add ${JSON.stringify(resolve(projectDir))} to trustedFolders in ${trust.configPath} yourself.`,
    severity: "warn",
  }];
}

function codexTrustEntries(seedText: string, projectDir: string): Array<{
  table: string;
  hash: string;
}> {
  const rendered = seedText.replaceAll("<PROJECT_DIR>", projectDir.replaceAll("\\", "/"));
  return [...rendered.matchAll(
    /^\[hooks\.state\."([^"]+)"\]\r?\ntrusted_hash\s*=\s*"([^"]+)"$/gm,
  )].map((match) => ({
    table: match[1],
    hash: match[2],
  }));
}

export function codexTrustIssues(
  projectDir: string,
  harnessDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticIssue[] {
  const seedPath = join(projectDir, harnessDir, "trust-seed.toml");
  const configPath = join(
    env.CODEX_HOME || join(env.HOME || homedir(), ".codex"),
    "config.toml",
  );
  if (!existsSync(seedPath)) {
    return [{
      id: "codex-trust-seed-missing",
      message: `${seedPath} is missing`,
      remediation: "Restore the complete .codex/trust-seed.toml from the selected projection.",
    }];
  }
  const entries = codexTrustEntries(readFileSync(seedPath, "utf-8"), projectDir);
  if (entries.length === 0) {
    return [{
      id: "codex-trust-seed-empty",
      message: "The Codex trust seed contains no hook identities",
      remediation: "Restore the complete .codex/trust-seed.toml from the selected projection.",
    }];
  }
  if (!existsSync(configPath)) {
    return [{
      id: "codex-hook-trust-missing",
      message: `Codex hook trust is absent because ${configPath} does not exist`,
      remediation:
        "Run one Codex TUI session and choose Trust all and continue, or replace <PROJECT_DIR> in the complete trust seed and merge the complete set into $CODEX_HOME/config.toml. Until then zero Codex hooks fire. --dangerously-bypass-hook-trust does not fire them. Do not append a duplicate set.",
    }];
  }
  const config = readFileSync(configPath, "utf-8");
  const missing = entries.filter(({ table, hash }) =>
    !config.includes(`[hooks.state.${JSON.stringify(table)}]`) ||
    !config.includes(`trusted_hash = ${JSON.stringify(hash)}`)
  );
  if (missing.length === 0) return [];
  return [{
    id: "codex-hook-trust-incomplete",
    message: `${missing.length} of ${entries.length} Codex hook trust entries are missing`,
    remediation:
      "Run one Codex TUI session and choose Trust all and continue, or replace <PROJECT_DIR> in the complete trust seed and merge the complete set into $CODEX_HOME/config.toml. Until then zero Codex hooks fire. --dangerously-bypass-hook-trust does not fire them. Replace the old set; appending a duplicate set produces invalid TOML.",
  }];
}

// A missing sibling is repaired by the same `--harness` refresh as a missing
// shell. The old remediation was a bare `aidlc config`, which on a project that
// already has a harness directory takes the interactive walk and rebuilds
// nothing. `harnessDir` selects the channel-correct command; callers without one
// (tests) get the native spelling.
export function workspaceSiblingIssues(
  projectDir: string,
  harness: ModelHarness,
  harnessDir?: string,
): DiagnosticIssue[] {
  const required: Array<{ id: string; path: string; reason: string }> = [{
    id: "workspace-root-missing",
    path: join(projectDir, "aidlc"),
    reason: "the harness-neutral workspace root",
  }];
  if (harness === "codex") {
    required.push({
      id: "codex-agents-sibling-missing",
      path: join(projectDir, ".agents"),
      reason: "the Codex skills sibling",
    });
  }
  if (harness === "opencode" || harness === "copilot") {
    required.push({
      id: `${harness}-engine-sibling-missing`,
      path: join(projectDir, ".aidlc"),
      reason: "the shared engine sibling",
    });
  }
  return required.filter((item) => !existsSync(item.path)).map((item) => ({
    id: item.id,
    message: `${item.reason} is missing at ${item.path}`,
    remediation: `Run ${
      harnessDir
        ? workspaceShellRefreshCommand(harnessDir, harness)
        : `aidlc config --harness ${harness}`
    } to restore the complete ${harness} projection, including sibling directories.`,
  }));
}

export function trustFilesForHarness(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
): string[] {
  const files = [
    join(projectDir, harnessDir, "tools", "data", "harness.json"),
  ];
  if (harness === "claude") files.push(join(projectDir, harnessDir, "settings.json"));
  if (harness === "codex") {
    files.push(
      join(projectDir, harnessDir, "hooks.json"),
      join(projectDir, harnessDir, "rules", "default.rules"),
      join(projectDir, harnessDir, "trust-seed.toml"),
      join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex"), "config.toml"),
    );
  }
  const kiroLayout = harness === "kiro-ide"
    ? "kas"
    : harness === "kiro"
      ? kiroTreeLayout(join(projectDir, harnessDir)) ?? "agent-v1"
      : null;
  if (kiroLayout) {
    // The agent-v1 layout grants trust in JSON agents and registers legacy hooks;
    // the KAS layout grants it in the Markdown agents' permissions and registers
    // v1 hook JSON, and pins the Kiro CLI engine in settings/cli.json. A `kiro`
    // project can carry either, so its installed tree decides.
    const agentSuffix = kiroLayout === "agent-v1" ? ".json" : ".md";
    const hookSuffix = kiroLayout === "agent-v1" ? ".kiro.hook" : ".json";
    const agentsDir = join(projectDir, harnessDir, "agents");
    if (existsSync(agentsDir)) {
      files.push(
        ...readdirSync(agentsDir)
          .filter((name) => name.endsWith(agentSuffix))
          .sort()
          .map((name) => join(agentsDir, name)),
      );
    }
    const hooksDir = join(projectDir, harnessDir, "hooks");
    if (existsSync(hooksDir)) {
      files.push(
        ...readdirSync(hooksDir)
          .filter((name) => name.endsWith(hookSuffix))
          .sort()
          .map((name) => join(hooksDir, name)),
      );
    }
  }
  if (kiroLayout === "kas") {
    files.push(join(projectDir, harnessDir, "settings", "cli.json"));
  }
  if (harness === "cursor") {
    files.push(
      join(projectDir, harnessDir, "hooks.json"),
      join(projectDir, harnessDir, "cli.json"),
    );
  }
  if (harness === "copilot") {
    files.push(join(projectDir, ".github", "hooks", "aidlc.json"), copilotConfigPath());
  }
  if (harness === "opencode") files.push(join(projectDir, "opencode.json"));
  return [...new Set(files)];
}

// A real `.git` pointer file is one short line.
const GIT_POINTER_MAX_BYTES = 64 * 1024;

// True iff `dir` or one of its ancestors holds a git checkout marker: a `.git`
// directory with a HEAD entry, or (a submodule or linked worktree) a small
// regular `.git` file reading `gitdir: <path>`. Only entries of these folders
// are examined, links are not followed, and a pointer's target is never opened,
// so a crafted project cannot send the check to another machine. An empty
// `.git` left behind is not a repository. Searched from the real path so a
// symlinked project reaches its real parents. Cursor may skip project hooks in
// a folder outside any git repository (#976).
export function insideGitRepository(dir: string): boolean {
  const checkout = (candidate: string): boolean => {
    const dotGit = join(candidate, ".git");
    try {
      if (lstatSync(dotGit).isDirectory()) {
        lstatSync(join(dotGit, "HEAD"));
        return true;
      }
    } catch {
      return false;
    }
    return /^gitdir: \S/.test(readBoundedRegularFile(dotGit, GIT_POINTER_MAX_BYTES) ?? "");
  };
  let current: string;
  try {
    current = realpathSync(dir);
  } catch {
    current = resolve(dir);
  }
  for (;;) {
    if (checkout(current)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function trustStatus(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  env: NodeJS.ProcessEnv = process.env,
): TrustStatus {
  const issues = workspaceSiblingIssues(projectDir, harness, harnessDir);
  if (harness === "codex") {
    issues.push(...codexTrustIssues(projectDir, harnessDir, env));
  }
  if (harness === "copilot") {
    issues.push(...copilotTrustIssues(projectDir, env));
  }
  return {
    files: trustFilesForHarness(projectDir, harnessDir, harness),
    issues,
  };
}

export type ConfigOutstandingAction = {
  // "workspace" is reported, never walked: there is no wizard that can answer
  // it, only a refresh that recreates the missing shell.
  section: "runtime" | "trust" | "providers" | "models" | "workspace";
  id: string;
  message: string;
  command: string;
  // What the person does in their own tool when no AI-DLC command does it.
  // Shown in place of the command; `command` then only checks the result.
  step?: string;
};

// Codex runs a project's hooks only once the person trusts them inside Codex,
// the same step the hooks-off stop and doctor name. AI-DLC's own trust review
// is a different thing, so this step never points at it.
export const CODEX_HOOK_TRUST_UNMET = "Codex has not trusted this project's hooks yet";
export const CODEX_HOOK_TRUST_STEP = "in Codex, type /hooks, press t to trust all, then press Esc";
const CODEX_HOOK_TRUST_IDS = new Set(["codex-hook-trust-missing", "codex-hook-trust-incomplete"]);

/** Codex's own hook-trust step for an issue it alone can fix, else null. */
export function codexHookTrustStep(issueId: string): string | null {
  return CODEX_HOOK_TRUST_IDS.has(issueId) ? CODEX_HOOK_TRUST_STEP : null;
}

// The runtimes this shell finds that the system-wide PATH does not. A harness
// started from this terminal hands them to its hooks, so setup lists no step
// for them and says where to start the harness instead.
export function shellOnlyRuntimes(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  options: RuntimeProbeOptions = {},
): string[] {
  return probeRuntime(projectDir, harnessDir, harness, { ...options, includeHarnessCli: false }).binaries
    .filter((binary) => binary.status === "interactive-only")
    .map((binary) => binary.name);
}

export function postApplyOutstandingActions(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  options: {
    skipSections?: readonly ConfigOutstandingAction["section"][];
    runtime?: RuntimeProbeOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
): ConfigOutstandingAction[] {
  const invoke = invocationForHarness(harnessDir);
  const skipped = new Set(options.skipSections ?? []);
  const actions: ConfigOutstandingAction[] = [];
  if (!skipped.has("runtime")) {
    const diagnostics = probeRuntime(projectDir, harnessDir, harness, {
      ...options.runtime,
      includeHarnessCli: false,
    });
    // A runtime found on this shell's PATH needs nothing from a harness started
    // from a terminal; the doctor says what to do if its hooks never run.
    const needed = {
      ...diagnostics,
      binaries: diagnostics.binaries.filter((binary) => binary.status !== "interactive-only"),
    };
    actions.push(...runtimeIssues(needed).map((issue) => ({
      section: "runtime" as const,
      id: issue.id,
      message: issue.message,
      command: `${invoke} config runtime`,
    })));
  }
  if (!skipped.has("trust")) {
    actions.push(...trustStatus(
      projectDir,
      harnessDir,
      harness,
      options.env,
    ).issues.map((issue) => {
      const step = codexHookTrustStep(issue.id);
      return step
        ? {
            section: "trust" as const,
            id: issue.id,
            message: CODEX_HOOK_TRUST_UNMET,
            command: `${invoke} config trust --check`,
            step,
          }
        : {
            section: "trust" as const,
            id: issue.id,
            message: issue.message,
            command: `${invoke} config trust`,
          };
    }));
  }
  if (!skipped.has("providers")) {
    try {
      const record = readConfigDiagnosticRecords(
        join(projectDir, harnessDir),
      ).providers;
      actions.push(...pendingProviderIssues(record, harness).map((issue) => ({
        section: "providers" as const,
        id: issue.id,
        message: issue.message,
        command: `${invoke} config providers --check`,
      })));
    } catch (error) {
      actions.push({
        section: "providers",
        id: "provider-record-unreadable",
        message: error instanceof Error ? error.message : String(error),
        command: `${invoke} config providers --check`,
      });
    }
  }
  return actions;
}

export { managedBlockMarkers };

// The team's own opencode.json may hold comments and trailing commas, as
// opencode allows.
function readTeamJsonFile(path: string): unknown {
  return Bun.JSONC.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
}

type RecordedInstructionContribution =
  | { policy: "managed-block"; hash: string; marker?: string }
  | { policy: "whole-file"; hash: string }
  | { policy: "json-entries"; entries: Record<string, string> };

type RecordedInstructionBaseline = {
  files?: Record<string, string>;
  rootContributions?: Record<string, RecordedInstructionContribution>;
};

type InstructionState = {
  path: string;
  kind: "managed-block" | "whole-file" | "json-entries";
  state: "intact" | "missing" | "conflict";
};

// AGENTS.md in a copy config never ran in: AI-DLC's part is the marked block
// the engine adds at session start, by the same rule config uses. A file that
// rule cannot take (unmarked AI-DLC text the team changed, broken markers) is
// a conflict, so the person hears what to fix instead of nothing.
function copiedAgentsState(
  projectDir: string,
  harnessDir: string,
  integration: RootIntegration,
): InstructionState {
  const path = "AGENTS.md";
  let shipped: string;
  let current: string;
  try {
    assertProjectionPathHasNoSymlinks(projectDir, `${harnessDir}/tools/data/root-blocks/${integration.marker}`);
    shipped = readFileSync(rootBlockPath(join(projectDir, harnessDir), integration), "utf-8");
    current = readFileSync(join(projectDir, path), "utf-8");
  } catch {
    return { path, kind: "whole-file", state: "intact" };
  }
  // The Cursor installer keeps AI-DLC's part under its own markers.
  if (/^<!-- BEGIN AIDLC [A-Z]+ -->/m.test(current)) return { path, kind: "managed-block", state: "intact" };
  const merged = mergeBlock(
    path,
    current,
    shipped,
    integration.marker ?? "agents",
    integration.legacySignatures?.wholeFileHashes ?? [],
  );
  if (merged.error) return { path, kind: "managed-block", state: "conflict" };
  return {
    path,
    kind: "managed-block",
    state: merged.currentHash !== undefined || merged.adoptedLegacy ? "intact" : "missing",
  };
}

function instructionStates(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
): InstructionState[] {
  let onboardingPath = harness === "claude" ? `${harnessDir}/CLAUDE.md` : undefined;
  let agentsBlock: RootIntegration | undefined;
  try {
    const descriptor: unknown = JSON.parse(readFileSync(
      join(projectDir, harnessDir, "tools", "data", "aidlc-projection.json"),
      "utf-8",
    ));
    if (
      isRecord(descriptor) &&
      isSafeOnboardingPath(descriptor.onboarding, harnessDir)
    ) {
      onboardingPath = descriptor.onboarding;
    }
    if (isRecord(descriptor) && Array.isArray(descriptor.rootIntegrations)) {
      agentsBlock = (descriptor.rootIntegrations as RootIntegration[]).find((integration) =>
        isRecord(integration) && integration.path === "AGENTS.md" && managedBlockIsSafe(integration)
      );
    }
  } catch {
    // Legacy installations may not have a readable onboarding descriptor.
  }
  let onboardingConflict = false;
  if (onboardingPath) {
    try {
      assertProjectionPathHasNoSymlinks(projectDir, onboardingPath);
    } catch {
      onboardingConflict = true;
    }
  }
  const baselinePath = join(
    projectDir,
    harnessDir,
    "tools",
    "data",
    "aidlc-manifest.json",
  );
  if (!existsSync(baselinePath)) {
    const instructionPaths = harness === "claude" ? [] : ["AGENTS.md"];
    if (onboardingPath && !instructionPaths.includes(onboardingPath)) {
      instructionPaths.push(onboardingPath);
    }
    return instructionPaths.map((path) => {
      if (path === onboardingPath && onboardingConflict) {
        return { path, kind: "whole-file", state: "conflict" };
      }
      const target = join(projectDir, path);
      if (!existsSync(target) || !lstatSync(target).isFile()) {
        return { path, kind: "whole-file", state: "missing" };
      }
      return path === "AGENTS.md" && agentsBlock
        ? copiedAgentsState(projectDir, harnessDir, agentsBlock)
        : { path, kind: "whole-file", state: "intact" };
    });
  }
  const baseline = JSON.parse(
    readFileSync(baselinePath, "utf-8"),
  ) as RecordedInstructionBaseline;
  const tracked: Array<{
    path: string;
    contribution: RecordedInstructionContribution;
  }> = [];
  for (const [path, contribution] of Object.entries(
    baseline.rootContributions ?? {},
  )) {
    if (
      path === "AGENTS.md" ||
      (path === "opencode.json" && (contribution.policy === "whole-file" || contribution.policy === "json-entries"))
    ) {
      tracked.push({ path, contribution });
    }
  }
  const onboardingHash = onboardingPath ? baseline.files?.[onboardingPath] : undefined;
  if (onboardingPath && onboardingHash) {
    tracked.push({
      path: onboardingPath,
      contribution: { policy: "whole-file", hash: onboardingHash },
    });
  }
  if (tracked.length === 0 && !onboardingPath) {
    return [{
      path: baselinePath,
      kind: "whole-file",
      state: "missing",
    }];
  }
  const states: InstructionState[] = tracked.map(({ path, contribution }) => {
    if (path === onboardingPath && onboardingConflict) {
      return { path, kind: "whole-file", state: "conflict" };
    }
    const target = join(projectDir, path);
    if (!existsSync(target) || !lstatSync(target).isFile()) {
      return {
        path,
        kind: contribution.policy,
        state: existsSync(target) ? "conflict" : "missing",
      };
    }
    const content = readFileSync(target);
    if (contribution.policy === "whole-file") {
      return {
        path,
        kind: contribution.policy,
        state: sha256Matching(content, [contribution.hash]) === contribution.hash ? "intact" : "conflict",
      };
    }
    if (contribution.policy === "json-entries") {
      // The team's own file: AI-DLC's instructions and skills entries must be
      // there; everything else in it is theirs.
      let shipped: string;
      try {
        assertProjectionPathHasNoSymlinks(projectDir, `${harnessDir}/tools/data/root-blocks/${path}`);
        shipped = readFileSync(join(projectDir, harnessDir, "tools", "data", "root-blocks", path), "utf-8");
      } catch {
        return { path, kind: contribution.policy, state: "intact" };
      }
      const missing = missingJsonEntries(content.toString("utf-8"), shipped, ["instructions", "skills"]);
      return {
        path,
        kind: contribution.policy,
        state: missing === null ? "conflict" : missing.length > 0 ? "missing" : "intact",
      };
    }
    const text = content.toString("utf-8");
    const markers = managedBlockMarkers(
      path,
      contribution.marker || path.split("/").pop() || path,
    );
    const begins = text.split(markers.begin).length - 1;
    const ends = text.split(markers.end).length - 1;
    if (begins === 0 && ends === 0) {
      return { path, kind: contribution.policy, state: "missing" };
    }
    const beginAt = text.indexOf(markers.begin);
    const endAt = text.indexOf(markers.end);
    if (begins !== 1 || ends !== 1 || endAt < beginAt) {
      return { path, kind: contribution.policy, state: "conflict" };
    }
    const block = text.slice(beginAt, endAt + markers.end.length);
    return {
      path,
      kind: contribution.policy,
      state: sha256Matching(block, [contribution.hash]) === contribution.hash ? "intact" : "conflict",
    };
  });
  if (onboardingPath && !onboardingHash) {
    states.push({
      path: onboardingPath,
      kind: "whole-file",
      state: onboardingConflict ? "conflict" : "missing",
    });
  }
  return states;
}

export function instructionFileDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
): DiagnosticDoctorCheck {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (!selected) {
    return {
      pass: true,
      label: "Instruction file: no installed project harness",
    };
  }
  const invoke = invocationForHarness(selected.harnessDir);
  let states: InstructionState[];
  try {
    states = instructionStates(
      projectDir,
      selected.harnessDir,
      selected.harness,
    );
  } catch (error) {
    return {
      pass: false,
      severity: "warn",
      label: "Instruction file: ownership baseline unreadable - conflict",
      fix: error instanceof Error ? error.message : String(error),
    };
  }
  const conflicts = states.filter((item) => item.state === "conflict");
  if (conflicts.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label:
        `Instruction file: hand-modified - conflict (${conflicts.map((item) => item.path).join(", ")})`,
      fix: keepOrTakeShipped(conflicts.map((item) => item.path), invoke),
    };
  }
  const missing = states.filter((item) => item.state === "missing");
  if (missing.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label:
        `Instruction file: block or file missing (${missing.map((item) => item.path).join(", ")})`,
      fix: `run \`${invoke} config\``,
    };
  }
  const managed = states.some((item) => item.kind === "managed-block" || item.kind === "json-entries");
  const whole = states.some((item) => item.kind === "whole-file");
  return {
    pass: true,
    label: managed && whole
      ? "Instruction file: block present, user content preserved; framework-owned file intact"
      : managed
      ? "Instruction file: block present, user content preserved"
      : "Instruction file: framework-owned file intact",
  };
}

function selectedHarness(
  projectDir: string,
  harnessDirHint?: string,
): {
  root: string;
  harnessDir: string;
  harness: ModelHarness;
  frameworkVersion?: string;
} | null {
  const harnesses = discoverProjectHarnesses(projectDir);
  const selected = harnessDirHint
    ? harnesses.find((candidate) => candidate.harnessDir === harnessDirHint) ??
      harnesses[0]
    : harnesses[0];
  if (!selected) return null;
  return {
    root: selected.root,
    harnessDir: selected.harnessDir,
    harness: selected.distribution as ModelHarness,
    ...(selected.frameworkVersion ? { frameworkVersion: selected.frameworkVersion } : {}),
  };
}

export function runtimeDoctorChecks(
  projectDir: string,
  harnessDirHint?: string,
  evidence: {
    /** The newest heartbeat of this project's hooks, when they are firing (not stale). */
    hooksLastFired?: string;
    runtime?: RuntimeProbeOptions;
  } = {},
): DiagnosticDoctorCheck[] {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (!selected) {
    return [{
      pass: true,
      label: "Runtime hook environment: no installed project harness",
    }];
  }
  const diagnostics = probeRuntime(
    projectDir,
    selected.harnessDir,
    selected.harness,
    evidence.runtime,
  );
  const checks: DiagnosticDoctorCheck[] = diagnostics.binaries.map((binary) => {
    // A projection's hooks run through one runtime, so hooks that are firing
    // found it on the PATH the harness really gives them: that settles what the
    // system-wide PATH can only predict.
    if (binary.status === "interactive-only" && evidence.hooksLastFired) {
      return {
        pass: true,
        label: `Runtime hook PATH: ${binary.name} -> ${binary.interactivePath} (this project's hooks found it; last fired ${evidence.hooksLastFired})`,
      };
    }
    return {
      pass: binary.status === "found" || binary.status === "not-required",
      ...(binary.status === "found" || binary.status === "not-required"
        ? {}
        : { severity: "warn" as const }),
      label: binary.status === "found"
        ? `Runtime hook PATH: ${binary.name} -> ${binary.baselinePath} (non-interactive baseline)`
        : binary.status === "not-required"
        ? `Runtime hook PATH: ${binary.name} is not required by the selected projection`
        : binary.status === "interactive-only"
        ? `Runtime hook PATH: ${binary.name} is on this shell's PATH (${binary.interactivePath}) but not on the system-wide PATH`
        : `Runtime hook PATH: ${binary.name} is missing`,
      fix: binary.remediation,
    };
  });
  const cli = diagnostics.cli;
  // Never a fail: a missing or old required CLI warns, and an optional one
  // passes when absent and warns only when present but too old.
  checks.push({
    pass: cli.status === "found" || cli.status === "not-applicable" ||
      (!cli.required && cli.status === "missing"),
    ...(cli.status === "too-old" || (cli.required && cli.status === "missing")
      ? { severity: "warn" as const }
      : {}),
    label: cli.status === "found"
      ? `Harness CLI: ${cli.command} ${cli.version || ""} at ${cli.path}`.trim()
      : cli.status === "not-applicable"
      ? `Harness CLI: none required for ${cli.harness}`
      : cli.status === "too-old"
      ? `Harness CLI: ${cli.required ? "" : "optional "}${cli.command} ${cli.version || "unknown"} is below ${cli.minimumVersion}`
      : cli.required
      ? `Harness CLI: ${cli.command} is missing`
      : `Harness CLI: optional ${cli.command} is not installed`,
    fix: cli.remediation,
  });
  return checks;
}

// VS Code pauses agent mode after `chat.agent.maxRequests` requests in one
// turn to ask "Continue to iterate?", and the chat waits silently until
// someone answers. Its default (50) stops a Construction stage part way, so a
// Copilot project should allow 100 or more; config adds 200 when unset (#1411).
const VSCODE_REQUEST_CAP_KEY = "chat.agent.maxRequests";
const VSCODE_REQUEST_CAP_FLOOR = 100;

export function vscodeRequestCapDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
): DiagnosticDoctorCheck | null {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (selected?.harness !== "copilot") return null;
  const label = "VS Code agent request cap:";
  const where = ".vscode/settings.json";
  let text: string | null = null;
  try {
    text = readFileSync(join(projectDir, ".vscode", "settings.json"), "utf-8");
  } catch {
    // Absent: VS Code's default applies.
  }
  if (text?.trim() && !jsoncRootMembers(text)) {
    return {
      pass: false,
      severity: "warn",
      label: `${label} ${where} could not be read as JSONC`,
      fix: `correct ${where}, then set "${VSCODE_REQUEST_CAP_KEY}" to 100 or more (AI-DLC suggests 200); ${REQUEST_CAP_PAUSES}`,
    };
  }
  const value = text?.trim() ? jsoncSettingValue(text, VSCODE_REQUEST_CAP_KEY) : undefined;
  // A key AI-DLC added once and the team then took out of a file it kept is
  // the team's choice: config does not add it back, and doctor does not ask.
  if (value === undefined && text !== null && requestCapAddedBefore(selected.root)) {
    return { pass: true, label: `${label} the team removed ${VSCODE_REQUEST_CAP_KEY} from ${where}, so AI-DLC leaves it out` };
  }
  return requestCapRow(label, where, value);
}

// A multi-root window reads window-scoped settings from its .code-workspace
// file instead of a folder's .vscode/settings.json, so when the project has
// the multi-root file workspace-sync generates, doctor checks it as well: it
// is the file in charge whenever the person opens that workspace.
export function vscodeWorkspaceRequestCapDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
): DiagnosticDoctorCheck | null {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (selected?.harness !== "copilot") return null;
  const label = "VS Code agent request cap (multi-root workspace):";
  const where = "aidlc.code-workspace";
  let text: string;
  try {
    text = readFileSync(join(projectDir, where), "utf-8");
  } catch {
    return null;
  }
  if (!jsoncRootMembers(text)) {
    return {
      pass: false,
      severity: "warn",
      label: `${label} ${where} could not be read as JSONC`,
      fix: `correct ${where}, then set "${VSCODE_REQUEST_CAP_KEY}" to 100 or more in its "settings" (AI-DLC suggests 200); ${REQUEST_CAP_PAUSES}`,
    };
  }
  const settings = jsoncSettingValue(text, "settings");
  if (settings === undefined) {
    return {
      pass: false,
      severity: "warn",
      label: `${label} ${where} has no settings, so a window opened from it uses your user setting or VS Code's default of 50`,
      fix: `run aidlc system workspace-sync, which adds "settings": { "${VSCODE_REQUEST_CAP_KEY}": 200 } to ${where}, or add it yourself; ${REQUEST_CAP_PAUSES}`,
    };
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return {
      pass: false,
      severity: "warn",
      label: `${label} "settings" in ${where} is not an object, so VS Code reads no settings from it`,
      fix: `make "settings" an object, for example "settings": { "${VSCODE_REQUEST_CAP_KEY}": 200 }; ${REQUEST_CAP_PAUSES}`,
    };
  }
  const value = (settings as Record<string, unknown>)[VSCODE_REQUEST_CAP_KEY];
  // workspace-sync adds the key only to a file with no settings yet, so a
  // settings object without it is the team's choice.
  if (value === undefined) {
    return { pass: true, label: `${label} the team's settings in ${where} leave out ${VSCODE_REQUEST_CAP_KEY}, so AI-DLC leaves it out` };
  }
  return requestCapRow(label, where, value);
}

const REQUEST_CAP_PAUSES = 'below 100, VS Code stops a long stage to ask "Continue to iterate?" and the chat waits until someone answers';

// The install's added-once record for .vscode/settings.json.
function requestCapAddedBefore(harnessRoot: string): boolean {
  try {
    const baseline = readJsonFile(join(harnessRoot, "tools", "data", "aidlc-manifest.json")) as {
      rootContributions?: Record<string, { policy?: string; entries?: Record<string, string>; added?: string[] }>;
    };
    const record = baseline.rootContributions?.[".vscode/settings.json"];
    return record?.policy === "jsonc-settings" &&
      (record.added?.includes(VSCODE_REQUEST_CAP_KEY) === true || Object.hasOwn(record.entries ?? {}, VSCODE_REQUEST_CAP_KEY));
  } catch {
    return false;
  }
}

function requestCapRow(label: string, where: string, value: unknown): DiagnosticDoctorCheck {
  const pauses = REQUEST_CAP_PAUSES;
  const suggested = `"${VSCODE_REQUEST_CAP_KEY}": 200`;
  const warn = (detail: string, fix: string): DiagnosticDoctorCheck => ({
    pass: false,
    severity: "warn",
    label: `${label} ${detail}`,
    fix,
  });
  if (typeof value === "number" && value >= VSCODE_REQUEST_CAP_FLOOR) {
    return { pass: true, label: `${label} ${VSCODE_REQUEST_CAP_KEY} is ${value} in ${where}` };
  }
  // Every fix is an edit to the file itself, which works on every channel: a
  // copied project's runtime ships no settings file for config to merge.
  if (value === undefined) {
    return warn(
      `${where} does not set ${VSCODE_REQUEST_CAP_KEY}, so your user setting or VS Code's default of 50 applies`,
      `add ${suggested} to ${where} (any number of 100 or more works); ${pauses}`,
    );
  }
  if (typeof value === "number") {
    return warn(
      `${VSCODE_REQUEST_CAP_KEY} is ${value} in ${where}`,
      `raise "${VSCODE_REQUEST_CAP_KEY}" in ${where} to 100 or more (AI-DLC suggests 200); ${pauses}`,
    );
  }
  if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) {
    const number = Number(value.trim());
    return warn(
      `${VSCODE_REQUEST_CAP_KEY} is ${JSON.stringify(value)} in ${where}, text rather than a number`,
      number >= VSCODE_REQUEST_CAP_FLOOR
        ? `write it as a number without quotes: "${VSCODE_REQUEST_CAP_KEY}": ${number}, because VS Code reads this setting as a number`
        : `write it as a number of 100 or more without quotes, for example ${suggested}; ${pauses}`,
    );
  }
  return warn(
    `${VSCODE_REQUEST_CAP_KEY} in ${where} is not a number`,
    `set it to a number of 100 or more, for example ${suggested}; ${pauses}`,
  );
}

export function providerDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
): DiagnosticDoctorCheck {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (!selected) {
    return { pass: true, label: "Providers: no installed project harness" };
  }
  try {
    const record = readConfigDiagnosticRecords(selected.root).providers;
    // Read first so corrupt harness data is still reported below. Legacy
    // answers on Kiro are ignored because those harnesses own model access.
    if (harnessOwnsModelAccess(selected.harness)) {
      return {
        pass: true,
        label: "Providers: harness-managed model access; no answer needed",
      };
    }
    const issues = providerIssues(
      projectDir,
      selected.harnessDir,
      selected.harness,
      record,
    );
    const blockers = issues.filter((issue) => issue.severity !== "warn");
    if (issues.length === 0) {
      return {
        pass: true,
        // Same rule as the map row and `--check`: an unrecorded section is a
        // gap only where AI-DLC configures the provider.
        label: record
          ? "Providers: recorded answers have no unmet actions"
          : providerAnswerIsTheSession(selected.harness)
          ? `Providers: ${sessionModelAccessFact(selected.harness)}; no answer needed`
          : "Providers: using shipped fallback; no recorded answers",
      };
    }
    return blockers.length === 0
      ? {
          pass: true,
          severity: "warn",
          label: `Providers: ${issues.length} warning(s)`,
          fix: issues.map((issue) => issue.message).join("; "),
        }
      : {
          pass: false,
          label: `Providers: ${blockers.length} unmet item(s)`,
          fix: blockers.map((issue) => issue.message).join("; "),
        };
  } catch (error) {
    const path = join(selected.root, "tools", "data", "harness.json");
    const detail = error instanceof Error ? error.message : String(error);
    // A newer release may record answers this one does not know (a pinned
    // project is configured by its pin, while doctor runs on the machine-active
    // release). That is not a damaged file, and restoring it would discard
    // valid answers: send the user to the release that wrote it.
    const writer = selected.frameworkVersion;
    if (
      writer && VERSION_ID.test(writer) && VERSION_ID.test(AIDLC_VERSION) &&
      compareVersions(writer, AIDLC_VERSION) > 0
    ) {
      const executable = installedExecutablePath(writer);
      return {
        pass: false,
        severity: "warn",
        label: `Providers: recorded answers are from aidlc ${writer}, newer than this aidlc ${AIDLC_VERSION}`,
        // Not the doctor command line itself: VS Code drops output up to a line that repeats it (#1411).
        fix: (existsSync(executable)
          ? `run doctor with aidlc ${writer} to check them; it is at \`${executable}\``
          : `install aidlc ${writer} with \`${aidlcInvocation()} update --version ${writer}\`, then rerun doctor`) +
          ` (${detail})`,
      };
    }
    return {
      pass: false,
      label: "Providers: could not read recorded answers",
      fix:
        `restore ${path} from git or re-copy dist/${selected.harness}/${selected.harnessDir}/tools/data/harness.json ` +
        // Not the doctor command itself: VS Code drops output up to a line that repeats it (#1411).
        "from the aidlc-workflows checkout, then run doctor again " +
        `(${detail})`,
    };
  }
}

export function flagsDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
  // The lines naming each check a recorded switch has turned off (doctor
  // builds them; this module stays free of the engine library).
  switchesOff: readonly string[] = [],
): DiagnosticDoctorCheck {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (!selected) {
    return { pass: true, label: "Flags: no installed project harness" };
  }
  try {
    const record = resolveAidlcSettings(projectDir).flags;
    const issues = flagIssues(
      projectDir,
      selected.harnessDir,
      selected.harness,
      record,
    );
    // A check switched off stays visible: a warning, never a failure.
    const off = switchesOff;
    if (off.length > 0) {
      return {
        pass: false,
        severity: "warn",
        label: `Flags: ${off.length} check${off.length === 1 ? "" : "s"} switched off`,
        fix: [...off, ...issues.map((issue) => issue.message)].join(" "),
      };
    }
    return issues.length === 0
      ? {
          pass: true,
          label: record
            ? "Flags: recorded answers are active without environment drift"
            : "Flags: no recorded project answers",
        }
      : {
          pass: false,
          severity: "warn",
          label: `Flags: ${issues.length} environment or surface override(s)`,
          fix: issues.map((issue) => issue.message).join("; "),
        };
  } catch (error) {
    return {
      pass: false,
      severity: "warn",
      label: "Flags: could not read recorded answers",
      fix: error instanceof Error ? error.message : String(error),
    };
  }
}

export function settingsDoctorChecks(
  projectDir: string,
): DiagnosticDoctorCheck[] {
  const checks: DiagnosticDoctorCheck[] = [];
  for (const [target, path] of [
    ["global", machineSettingsPath()],
    ["project", projectSettingsPath(projectDir)],
    ["local", localSettingsPath(projectDir)],
  ] as const) {
    if (!existsSync(path)) continue;
    try {
      readSettingsTarget(projectDir, target);
      checks.push({
        pass: true,
        label: `Settings ${target}: ${path} is valid`,
      });
    } catch (error) {
      checks.push({
        pass: false,
        label: `Settings ${target}: ${path} is invalid`,
        fix: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const local = localSettingsPath(projectDir);
  if (existsSync(local) && existsSync(join(projectDir, ".git"))) {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", "--", LOCAL_SETTINGS_FILE],
      {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
      },
    ).status === 0;
    checks.push({
      pass: !tracked,
      severity: tracked ? "warn" : undefined,
      label: tracked
        ? `Settings local: ${LOCAL_SETTINGS_FILE} is git-tracked`
        : `Settings local: ${LOCAL_SETTINGS_FILE} is not git-tracked`,
      fix: tracked
        ? `remove ${LOCAL_SETTINGS_FILE} from git tracking and keep its .gitignore entry`
        : undefined,
    });
  }
  return checks;
}

export function workspaceSiblingDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
): DiagnosticDoctorCheck {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (!selected) {
    return { pass: true, label: "Workspace siblings: no installed project harness" };
  }
  const issues = workspaceSiblingIssues(projectDir, selected.harness, selected.harnessDir);
  return issues.length === 0
    ? { pass: true, label: "Workspace siblings: complete projection is present" }
    : {
        pass: false,
        severity: "warn",
        label: `Workspace siblings: ${issues.length} required path(s) missing`,
        fix: issues.map((issue) => issue.message).join("; "),
      };
}

// The AI-DLC files a refresh refuses to replace: each one config recorded that
// now differs from what it wrote (line endings aside, #2057). The onboarding
// file is the instruction row's; files config merges or writes again itself
// are never refused, so they are not named.
function changedFrameworkFiles(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  baseline: { files?: Record<string, string>; entries?: Record<string, unknown> },
): string[] {
  const data = join(projectDir, harnessDir, "tools", "data");
  let onboarding = harness === "claude" ? `${harnessDir}/CLAUDE.md` : undefined;
  try {
    const descriptor: unknown = JSON.parse(readFileSync(join(data, "aidlc-projection.json"), "utf-8"));
    if (isRecord(descriptor) && isSafeOnboardingPath(descriptor.onboarding, harnessDir)) {
      onboarding = descriptor.onboarding;
    }
  } catch {
    // The instruction row reports an unreadable descriptor.
  }
  const generated = [
    ...["harness.json", "stage-graph.json", "scope-grid.json"].map((name) => `${harnessDir}/tools/data/${name}`),
    // The engine writes Kiro IDE's steering copy of the project's memory itself.
    `${harnessDir}/steering/aidlc-active-memory.md`,
  ];
  // Config takes a plugin's additions to stage files out before it compares.
  const pluginStages = existsSync(data) &&
    readdirSync(data).some((name) => /^plugin-contrib-.+\.json$/.test(name));
  const changed: string[] = [];
  for (const [rel, hash] of Object.entries(baseline.files ?? {})) {
    if (
      typeof hash !== "string" ||
      rel === onboarding ||
      baseline.entries?.[rel] !== undefined ||
      generated.includes(rel) ||
      (pluginStages && rel.startsWith(`${harnessDir}/aidlc-common/stages/`)) ||
      rel.startsWith("/") ||
      rel.split("/").includes("..")
    ) continue;
    const path = join(projectDir, rel);
    let regular: boolean;
    try {
      regular = lstatSync(path).isFile();
    } catch {
      continue;
    }
    if (regular) {
      const content = readFileSync(path);
      if (sha256Matching(content, [hash]) === hash || content.includes("generated-by: aidlc-runner-gen")) continue;
    }
    changed.push(rel);
  }
  return changed.sort();
}

export function frameworkFilesDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
): DiagnosticDoctorCheck {
  const selected = selectedHarness(projectDir, harnessDirHint);
  if (!selected) return { pass: true, label: "AI-DLC files: no installed project harness" };
  let baseline: { files?: Record<string, string>; entries?: Record<string, unknown> };
  try {
    baseline = JSON.parse(readFileSync(
      join(projectDir, selected.harnessDir, "tools", "data", "aidlc-manifest.json"),
      "utf-8",
    ));
  } catch {
    // The instruction row reports a missing or unreadable record.
    return { pass: true, label: "AI-DLC files: not checked, no record of what AI-DLC wrote" };
  }
  const changed = changedFrameworkFiles(projectDir, selected.harnessDir, selected.harness, baseline);
  if (changed.length === 0) return { pass: true, label: "AI-DLC files: unchanged since AI-DLC wrote them" };
  const invoke = invocationForHarness(selected.harnessDir);
  const one = changed.length === 1;
  const shown = changed.slice(0, 10).join(", ");
  const more = changed.length > 10
    ? `, and ${changed.length - 10} more; \`${invoke} config --dry-run\` names them all`
    : "";
  return {
    pass: false,
    severity: "warn",
    label: `AI-DLC files: ${changed.length} changed in this project, so \`${invoke} config\` keeps ${
      one ? "it" : "them"
    } and stops (${shown}${more})`,
    fix: keepOrTakeShipped(changed, invoke),
  };
}

// The two ways forward config itself offers for a file it will not replace,
// shared by the instruction and AI-DLC files rows.
function keepOrTakeShipped(paths: readonly string[], invoke: string): string {
  return paths.length === 1
    ? `to keep your version, move ${paths[0]} somewhere else, then run \`${invoke} config\`; ` +
      `to take the shipped version over it, run \`${invoke} config --force\``
    : `to keep your versions, move those files somewhere else, then run \`${invoke} config\`; ` +
      `to take the shipped versions over them, run \`${invoke} config --force\``;
}
