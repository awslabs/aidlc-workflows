import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as hostPlatform } from "node:os";
import { delimiter, extname, join, relative, resolve } from "node:path";
import { sha256Bytes } from "./aidlc-distribution.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
} from "./aidlc-runtime-paths.ts";
import type { ModelHarness } from "./aidlc-model-policy.ts";
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

export type ProviderKind = "amazon-bedrock" | "other";
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
  "kiro-ide-chat-model": {
    label:
      "Select the intended Amazon Bedrock chat model in the Kiro IDE model picker.",
    remediation:
      "Open Kiro IDE, choose the intended Bedrock model in the chat model picker, then rerun this check.",
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
    if (value.provider !== "amazon-bedrock" && value.provider !== "other") {
      throw new Error("providers.provider must be amazon-bedrock or other");
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
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const policyKeys = ["models", "flags"].filter((key) => Object.hasOwn(value, key));
  if (policyKeys.length > 0) {
    throw new Error(
      `${path}: harness.json contains legacy policy key(s) ${policyKeys.join(", ")}. ` +
        `Remove ${policyKeys.join(", ")} from ${path}, then run ` +
        `'${aidlcInvocation()} config' to record policy in aidlc.settings.json.`,
    );
  }
  return {
    runtime: normalizeRuntimeRecord(value.runtime),
    providers: normalizeProvidersRecord(value.providers),
    trust: normalizeTrustRecord(value.trust),
    project: normalizeProjectChoicesRecord(value.project),
  };
}

function defaultRun(
  command: string,
  args: readonly string[],
): { status: number; stdout: string } {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    timeout: 5_000,
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
  return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
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
  if (platform === "darwin") {
    for (const path of ["/etc/paths"]) {
      if (!existsSync(path)) continue;
      entries.push(
        ...readFileSync(path, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      );
    }
    const pathsDir = "/etc/paths.d";
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
  }
  return [...new Set(entries)].join(delimiter);
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

function runtimeRemediation(
  name: "bun" | "aidlc",
  platform: NodeJS.Platform,
): string {
  if (name === "bun") {
    return platform === "win32"
      ? "Install Bun, then add its install directory to the Windows User or Machine PATH, not only a shell profile."
      : "Install Bun, then add ~/.bun/bin to the login-independent environment used by the harness, not only .zshrc or .bash_profile.";
  }
  return platform === "win32"
    ? "Add the aidlc command directory to the Windows User or Machine PATH."
    : "Add ~/.local/bin to the login-independent environment used by the harness, not only an interactive shell rc file.";
}

function binaryProbe(
  name: "bun" | "aidlc",
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
      remediation: runtimeRemediation(name, platform),
    };
  }
  return {
    name,
    required,
    status: "missing",
    remediation: runtimeRemediation(name, platform),
  };
}

const HARNESS_CLI: Record<
  ModelHarness,
  {
    command?: string;
    required: boolean;
    minimumVersion?: string;
    install: string;
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
  },
  cursor: {
    command: "cursor",
    required: false,
    install: "Install the Cursor CLI and ensure `cursor --version` works; IDE-only installs may omit it.",
  },
  kiro: {
    command: "kiro-cli",
    required: true,
    install: "Install Kiro CLI and ensure `kiro-cli --version` works.",
  },
  "kiro-ide": {
    required: false,
    install: "Kiro IDE has no required separate CLI for this project surface.",
  },
  opencode: {
    command: "opencode",
    required: true,
    install: "Install opencode and ensure `opencode --version` works.",
  },
};

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
  const path = which(spec.command, interactivePath);
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
  if (result.status !== 0) {
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
      binaryProbe("bun", requirements.bun, baselinePath, interactivePath, options),
      binaryProbe("aidlc", requirements.aidlc, baselinePath, interactivePath, options),
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
  if (record.provider === "other") return ["non-bedrock-provider-configuration"];
  if (record.provider !== "amazon-bedrock") return [];
  const actions: ProviderPendingActionId[] = ["bedrock-model-access"];
  if (harness === "kiro-ide") actions.push("kiro-ide-chat-model");
  if (harness === "copilot") actions.push("copilot-byok-configuration");
  if (harness === "cursor") actions.push("cursor-provider-configuration");
  return actions;
}

export function reconcileProviderActions(
  record: ProvidersRecord,
  harness: ModelHarness,
): ProvidersRecord {
  const current = new Map(
    (record.pendingActions ?? []).map((action) => [action.id, action.status]),
  );
  const required = requiredProviderActions(record, harness);
  const pendingActions = required.map((id) => {
    const acknowledgeGated =
      id === "copilot-byok-configuration" ||
      id === "cursor-provider-configuration" ||
      id === "non-bedrock-provider-configuration";
    return {
      id,
      status: record.acknowledged && acknowledgeGated
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
): DiagnosticIssue[] {
  if (!record) return [];
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeClaudeProvider(
  projectionRoot: string,
  harnessDir: string,
  record: ProvidersRecord,
): void {
  const settingsPath = join(projectionRoot, harnessDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  const env = isRecord(settings.env) ? { ...settings.env } : {};
  env.AWS_REGION = record.region;
  if (record.profile) env.AWS_PROFILE = record.profile;
  else delete env.AWS_PROFILE;
  settings.env = env;
  writeJson(settingsPath, settings);

  const mcpPath = join(projectionRoot, ".mcp.json");
  if (!existsSync(mcpPath)) return;
  const mcp = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>;
  const servers = isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
  const aws = isRecord(servers["aws-mcp"]) ? servers["aws-mcp"] : null;
  if (!aws || !Array.isArray(aws.args)) return;
  aws.args = aws.args.map((arg) => {
    if (typeof arg !== "string") return arg;
    if (/^https:\/\/aws-mcp\.[^.]+\.api\.aws\/mcp$/.test(arg)) {
      return `https://aws-mcp.${record.region}.api.aws/mcp`;
    }
    if (/^AWS_REGION=/.test(arg)) return `AWS_REGION=${record.region}`;
    return arg;
  });
  writeJson(mcpPath, mcp);
}

function writeCodexProvider(
  projectionRoot: string,
  harnessDir: string,
  record: ProvidersRecord,
): void {
  const path = join(projectionRoot, harnessDir, "config.toml");
  const content = readFileSync(path, "utf-8");
  const section = /(\[model_providers\.amazon-bedrock\.aws\]\r?\n)([\s\S]*?)(?=\r?\n\[|$)/;
  const match = section.exec(content);
  if (!match) throw new Error(`${path}: missing amazon-bedrock aws provider section`);
  const profile = record.profile ?? "default";
  const lines = match[2].split(/\r?\n/).map((line) => {
    if (/^profile\s*=/.test(line)) return `profile = ${JSON.stringify(profile)}`;
    if (/^region\s*=/.test(line)) return `region = ${JSON.stringify(record.region)}`;
    return line;
  });
  writeFileSync(
    path,
    content.replace(section, () => `${match[1]}${lines.join("\n")}`),
  );
}

function writeKiroProvider(
  projectionRoot: string,
  harnessDir: string,
  record: ProvidersRecord,
): void {
  const path = join(projectionRoot, harnessDir, "settings", "mcp.json");
  if (!existsSync(path)) return;
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const servers = isRecord(value.mcpServers) ? value.mcpServers : {};
  const aws = isRecord(servers["aws-mcp"]) ? servers["aws-mcp"] : null;
  if (!aws || !Array.isArray(aws.args)) return;
  aws.args = aws.args.map((arg) => {
    if (typeof arg !== "string") return arg;
    if (/^https:\/\/aws-mcp\.[^.]+\.api\.aws\/mcp$/.test(arg)) {
      return `https://aws-mcp.${record.region}.api.aws/mcp`;
    }
    if (/^AWS_REGION=/.test(arg)) return `AWS_REGION=${record.region}`;
    return arg;
  });
  writeJson(path, value);
}

function writeOpenCodeProvider(
  projectionRoot: string,
  record: ProvidersRecord,
): void {
  if (!record.opencodeDefault) return;
  const path = join(projectionRoot, "opencode.json");
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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

function writeClaudeFlags(
  projectionRoot: string,
  harnessDir: string,
  record: ProjectFlagsRecord,
): void {
  if (!record.defaultScope) return;
  const path = join(projectionRoot, harnessDir, "settings.json");
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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
): void {
  const provider = records.providers;
  if (provider?.provider !== "amazon-bedrock" || !provider.region) return;
  if (harness === "claude") {
    writeClaudeProvider(projectionRoot, harnessDir, provider);
  } else if (harness === "codex") {
    writeCodexProvider(projectionRoot, harnessDir, provider);
  } else if (harness === "kiro") {
    writeKiroProvider(projectionRoot, harnessDir, provider);
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
  } else if (harness === "codex") {
    files.push({
      setting: "Bedrock AWS region and profile",
      file: join(harnessDir, "config.toml"),
    });
  } else if (harness === "kiro") {
    files.push({
      setting: "AWS MCP region endpoint and metadata",
      file: join(harnessDir, "settings", "mcp.json"),
    });
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
      const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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

export function discoverInstalledPluginNames(
  projectDir: string,
  harnessDir: string,
): string[] {
  const names = new Set<string>(["aidlc"]);
  const dataDir = join(projectDir, harnessDir, "tools", "data");
  if (existsSync(dataDir)) {
    for (const file of readdirSync(dataDir).sort()) {
      const match = /^(?:plugin-contrib|plugin-owned|plugin-compose)-([a-z][a-z0-9-]*)\.json$/
        .exec(file);
      if (match) names.add(match[1]);
    }
    const graphPath = join(dataDir, "stage-graph.json");
    if (existsSync(graphPath)) {
      try {
        collectPluginNames(JSON.parse(readFileSync(graphPath, "utf-8")), names);
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
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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
      const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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

function providerValueIssues(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  record: ProvidersRecord,
): DiagnosticIssue[] {
  if (record.provider !== "amazon-bedrock" || !record.region) return [];
  const issues: DiagnosticIssue[] = [];
  const mismatch = (id: string, file: string, message: string): void => {
    issues.push({
      id,
      message,
      remediation: `Run aidlc config providers again to reapply the recorded answer to ${file}.`,
    });
  };
  try {
    if (harness === "claude") {
      const settingsPath = join(projectDir, harnessDir, "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const env = isRecord(settings.env) ? settings.env : {};
      if (env.AWS_REGION !== record.region || (record.profile && env.AWS_PROFILE !== record.profile)) {
        mismatch("provider-claude-settings", settingsPath, "Claude settings do not reflect the recorded AWS region/profile");
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
    } else if (harness === "codex") {
      const path = join(projectDir, harnessDir, "config.toml");
      const text = readFileSync(path, "utf-8");
      if (
        !text.includes(`region = ${JSON.stringify(record.region)}`) ||
        !text.includes(`profile = ${JSON.stringify(record.profile ?? "default")}`)
      ) {
        mismatch("provider-codex", path, "Codex Bedrock settings do not reflect the recorded region/profile");
      }
    } else if (harness === "kiro") {
      const path = join(projectDir, harnessDir, "settings", "mcp.json");
      const text = readFileSync(path, "utf-8");
      if (
        !text.includes(`https://aws-mcp.${record.region}.api.aws/mcp`) ||
        !text.includes(`AWS_REGION=${record.region}`)
      ) {
        mismatch("provider-kiro", path, "Kiro AWS MCP settings do not reflect the recorded region");
      }
    } else if (harness === "opencode" && record.opencodeDefault) {
      const path = join(projectDir, "opencode.json");
      const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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
  if (!record) return [];
  const issues = [
    ...pendingProviderIssues(record),
    ...providerValueIssues(projectDir, harnessDir, harness, record),
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

export function workspaceSiblingIssues(
  projectDir: string,
  harness: ModelHarness,
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
    remediation: `Run aidlc config to restore the complete ${harness} projection, including sibling directories.`,
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
  if (harness === "kiro" || harness === "kiro-ide") {
    const agentsDir = join(projectDir, harnessDir, "agents");
    if (existsSync(agentsDir)) {
      files.push(
        ...readdirSync(agentsDir)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(agentsDir, name)),
      );
    }
    const hooksDir = join(projectDir, harnessDir, "hooks");
    if (existsSync(hooksDir)) {
      files.push(
        ...readdirSync(hooksDir)
          .filter((name) => name.endsWith(".kiro.hook"))
          .sort()
          .map((name) => join(hooksDir, name)),
      );
    }
  }
  if (harness === "kiro-ide") {
    files.push(join(projectDir, ".vscode", "settings.json"));
  }
  if (harness === "cursor") {
    files.push(
      join(projectDir, harnessDir, "hooks.json"),
      join(projectDir, harnessDir, "cli.json"),
    );
  }
  if (harness === "copilot") files.push(join(projectDir, ".github", "hooks", "aidlc.json"));
  if (harness === "opencode") files.push(join(projectDir, "opencode.json"));
  return [...new Set(files)];
}

export function trustStatus(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  env: NodeJS.ProcessEnv = process.env,
): TrustStatus {
  const issues = workspaceSiblingIssues(projectDir, harness);
  if (harness === "codex") {
    issues.push(...codexTrustIssues(projectDir, harnessDir, env));
  }
  if (harness === "kiro-ide") {
    const path = join(projectDir, ".vscode", "settings.json");
    try {
      const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      const trusted = value["kiroAgent.trustedCommands"];
      if (!Array.isArray(trusted) || !trusted.includes("aidlc engine *")) {
        issues.push({
          id: "kiro-ide-trusted-command-missing",
          message: `${path} does not include aidlc engine * in kiroAgent.trustedCommands`,
          remediation:
            "Run aidlc config from the native install channel or add aidlc engine * to kiroAgent.trustedCommands without replacing other settings.",
        });
      }
    } catch {
      issues.push({
        id: "kiro-ide-trust-unreadable",
        message: `${path} is missing or malformed`,
        remediation:
          "Restore .vscode/settings.json and include aidlc engine * in kiroAgent.trustedCommands.",
      });
    }
  }
  return {
    files: trustFilesForHarness(projectDir, harnessDir, harness),
    issues,
  };
}

export type ConfigOutstandingAction = {
  section: "runtime" | "trust" | "providers";
  id: string;
  message: string;
  command: string;
};

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
    actions.push(...runtimeIssues(diagnostics).map((issue) => ({
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
    ).issues.map((issue) => ({
      section: "trust" as const,
      id: issue.id,
      message: issue.message,
      command: `${invoke} config trust`,
    })));
  }
  if (!skipped.has("providers")) {
    try {
      const record = readConfigDiagnosticRecords(
        join(projectDir, harnessDir),
      ).providers;
      actions.push(...pendingProviderIssues(record).map((issue) => ({
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

export function managedBlockMarkers(
  path: string,
  identity: string,
): { begin: string; end: string } {
  return path.endsWith(".md")
    ? {
        begin: `<!-- BEGIN AI-DLC:${identity} -->`,
        end: `<!-- END AI-DLC:${identity} -->`,
      }
    : {
        begin: `# BEGIN AI-DLC:${identity}`,
        end: `# END AI-DLC:${identity}`,
      };
}

type RecordedInstructionContribution =
  | { policy: "managed-block"; hash: string; marker?: string }
  | { policy: "whole-file"; hash: string };

type RecordedInstructionBaseline = {
  files?: Record<string, string>;
  rootContributions?: Record<string, RecordedInstructionContribution>;
};

type InstructionState = {
  path: string;
  kind: "managed-block" | "whole-file";
  state: "intact" | "missing" | "conflict";
};

function instructionStates(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
): InstructionState[] {
  const baselinePath = join(
    projectDir,
    harnessDir,
    "tools",
    "data",
    "aidlc-manifest.json",
  );
  if (!existsSync(baselinePath)) {
    const instructionPath = harness === "claude"
      ? `${harnessDir}/CLAUDE.md`
      : "AGENTS.md";
    return [{
      path: instructionPath,
      kind: "whole-file",
      state: existsSync(join(projectDir, instructionPath))
        ? "intact"
        : "missing",
    }];
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
      (path === "opencode.json" && contribution.policy === "whole-file")
    ) {
      tracked.push({ path, contribution });
    }
  }
  if (harness === "claude") {
    const path = `${harnessDir}/CLAUDE.md`;
    const hash = baseline.files?.[path];
    if (hash) {
      tracked.push({
        path,
        contribution: { policy: "whole-file", hash },
      });
    }
  }
  if (tracked.length === 0) {
    return [{
      path: baselinePath,
      kind: "whole-file",
      state: "missing",
    }];
  }
  return tracked.map(({ path, contribution }) => {
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
        state: sha256Bytes(content) === contribution.hash ? "intact" : "conflict",
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
      state: sha256Bytes(block) === contribution.hash ? "intact" : "conflict",
    };
  });
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
      fix: `review the local changes, then run \`${invoke} config\``,
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
  const managed = states.some((item) => item.kind === "managed-block");
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
  };
}

export function runtimeDoctorChecks(
  projectDir: string,
  harnessDirHint?: string,
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
  );
  const checks: DiagnosticDoctorCheck[] = diagnostics.binaries.map((binary) => ({
    pass: binary.status === "found" || binary.status === "not-required",
    ...(binary.status === "found" || binary.status === "not-required"
      ? {}
      : { severity: "warn" as const }),
    label: binary.status === "found"
      ? `Runtime hook PATH: ${binary.name} -> ${binary.baselinePath} (non-interactive baseline)`
      : binary.status === "not-required"
      ? `Runtime hook PATH: ${binary.name} is not required by the selected projection`
      : binary.status === "interactive-only"
      ? `Runtime hook PATH: ${binary.name} is interactive-only at ${binary.interactivePath}`
      : `Runtime hook PATH: ${binary.name} is missing`,
    fix: binary.remediation,
  }));
  const cli = diagnostics.cli;
  checks.push({
    pass: cli.status === "found" || cli.status === "not-applicable" ||
      (!cli.required && cli.status === "missing"),
    ...(cli.required && (cli.status === "missing" || cli.status === "too-old")
      ? { severity: "warn" as const }
      : {}),
    label: cli.status === "found"
      ? `Harness CLI: ${cli.command} ${cli.version || ""} at ${cli.path}`.trim()
      : cli.status === "not-applicable"
      ? `Harness CLI: none required for ${cli.harness}`
      : cli.status === "too-old"
      ? `Harness CLI: ${cli.command} ${cli.version || "unknown"} is below ${cli.minimumVersion}`
      : cli.required
      ? `Harness CLI: ${cli.command} is missing`
      : `Harness CLI: optional ${cli.command} is not installed`,
    fix: cli.remediation,
  });
  return checks;
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
    const issues = pendingProviderIssues(record);
    return issues.length === 0
      ? {
          pass: true,
          label: record
            ? "Providers: recorded answers have no unmet actions"
            : "Providers: using shipped fallback; no recorded answers",
        }
      : {
          pass: false,
          severity: "warn",
          label: `Providers: ${issues.length} unmet item(s)`,
          fix: issues.map((issue) => issue.message).join("; "),
        };
  } catch (error) {
    const path = join(selected.root, "tools", "data", "harness.json");
    return {
      pass: false,
      label: "Providers: could not read recorded answers",
      fix:
        `restore ${path} from git or re-copy dist/${selected.harness}/${selected.harnessDir}/tools/data/harness.json ` +
        `from the aidlc-workflows checkout, then run \`${invocationForHarness(selected.harnessDir)} doctor\` ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function flagsDoctorCheck(
  projectDir: string,
  harnessDirHint?: string,
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
        timeout: 5_000,
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
  const issues = workspaceSiblingIssues(projectDir, selected.harness);
  return issues.length === 0
    ? { pass: true, label: "Workspace siblings: complete projection is present" }
    : {
        pass: false,
        severity: "warn",
        label: `Workspace siblings: ${issues.length} required path(s) missing`,
        fix: issues.map((issue) => issue.message).join("; "),
      };
}
