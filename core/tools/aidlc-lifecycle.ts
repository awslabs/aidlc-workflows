#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractTarGz } from "./aidlc-archive.ts";
import {
  renderCompletion,
  type Shell,
} from "./aidlc-completions.ts";
import {
  EXIT,
  type CommandResult,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
  valueAfter,
} from "./aidlc-command.ts";
import {
  success as successText,
  warnVerdict,
} from "./aidlc-color.ts";
import {
  projectionFiles,
  sha256File,
  walkFiles,
} from "./aidlc-distribution.ts";
import {
  activeVersion,
  activeExecutablePath,
  activeVersionPath,
  binRoot,
  canonicalPolicyPath,
  commandPath,
  createRuntimeIntegrity,
  installedExecutablePath,
  inspectProjectPinTarget,
  inspectInstalledVersion,
  installRoot,
  machineTransactionRoot,
  packageManagerForExecutable,
  projectPinTargetPath,
  projectDirFrom,
  requireVersion,
  readActiveExecutable,
  rollbackVersionPath,
  runtimeIntegrityPath,
  runtimeRoot,
  STRICT_SEMVER,
  targetTriple,
  versionRoot,
  versionsRoot,
} from "./aidlc-install-paths.ts";
import {
  defaultHarnessPath,
  machineConfigPath,
  updateCachePath,
} from "./aidlc-machine-config.ts";
import {
  acquireRelease,
  digest,
  ReleaseUnavailableError,
} from "./aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { refreshUpdateState } from "./aidlc-update.ts";
import {
  recoverWindowsUninstallContinuations,
  scheduleWindowsUninstall as scheduleWindowsUninstallContinuation,
} from "./aidlc-windows-uninstall.ts";
import {
  compiledExecutable,
  discoverProjectHarnesses,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

class LifecycleCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "LifecycleCommandError";
  }
}

function commandError(message: string, exitCode: number): never {
  throw new LifecycleCommandError(message, exitCode);
}

function requestedVersion(value: string): string {
  try {
    return requireVersion(value);
  } catch (error) {
    return commandError(
      error instanceof Error ? error.message : String(error),
      EXIT.usage,
    );
  }
}

function offline(argv: readonly string[]): boolean | undefined {
  if (argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1") return true;
  if (process.env.AIDLC_OFFLINE === "0") return false;
  return undefined;
}

type PublicLifecycleCommand = "update" | "use" | "uninstall";

type PublicLifecycleGrammar = {
  values: ReadonlySet<string>;
  bare: ReadonlySet<string>;
  positionals: number;
};

const PUBLIC_LIFECYCLE_GRAMMARS: Readonly<
  Record<PublicLifecycleCommand, PublicLifecycleGrammar>
> = {
  update: {
    values: new Set([
      "--ca-bundle",
      "--from",
      "--project-dir",
      "--release-base-url",
      "--version",
    ]),
    bare: new Set([
      "--check",
      "--dry-run",
      "--json",
      "--no-color",
      "--offline",
      "--quiet",
    ]),
    positionals: 0,
  },
  use: {
    values: new Set([
      "--ca-bundle",
      "--from",
      "--project-dir",
      "--release-base-url",
    ]),
    bare: new Set([
      "--json",
      "--no-color",
      "--offline",
      "--quiet",
    ]),
    positionals: 1,
  },
  uninstall: {
    values: new Set(["--project-dir"]),
    bare: new Set([
      "--json",
      "--no-color",
      "--purge",
      "--quiet",
      "--yes",
    ]),
    positionals: 0,
  },
};

export function validatePublicLifecycleArgs(
  argv: readonly string[],
): string | null {
  const command = argv[0] as PublicLifecycleCommand | undefined;
  const grammar = command ? PUBLIC_LIFECYCLE_GRAMMARS[command] : undefined;
  if (!grammar) return null;

  const seen = new Set<string>();
  const positionals: string[] = [];
  let startIndex = 1;
  if (command === "use") {
    const version = argv[1];
    if (!version || version.startsWith("--")) {
      return "use requires the version before options";
    }
    positionals.push(version);
    startIndex = 2;
  }
  for (let index = startIndex; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (grammar.values.has(token)) {
      if (seen.has(token)) return `${token} may be specified only once`;
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return `${token} requires a value`;
      seen.add(token);
      index++;
      continue;
    }
    if (!grammar.bare.has(token)) return `unknown ${command} option ${token}`;
    if (seen.has(token)) return `${token} may be specified only once`;
    seen.add(token);
  }

  if (positionals.length !== grammar.positionals) {
    if (command === "use" && positionals.length === 0) {
      return "use requires exactly one version";
    }
    return `unexpected ${command} positional ${
      JSON.stringify(positionals[grammar.positionals] ?? positionals[0])
    }`;
  }
  if (argv.includes("--json") && argv.includes("--quiet")) {
    return "--json and --quiet are mutually exclusive";
  }
  if (command === "update" && argv.includes("--check")) {
    for (const flag of ["--dry-run", "--from", "--version"]) {
      if (argv.includes(flag)) return `--check cannot be combined with ${flag}`;
    }
  }
  return null;
}

const RUNTIME_ASSET = "aidlc-runtime.tar.gz";
const COMPLETION_FILES: Readonly<Record<Shell, string>> = {
  bash: "aidlc.bash",
  zsh: "_aidlc",
  fish: "aidlc.fish",
  powershell: "aidlc.ps1",
};

function binaryAsset(target = targetTriple()): string {
  return `aidlc-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
}

function installedDistributions(version: string): string[] {
  const root = runtimeRoot(version);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => {
    try {
      projectionFiles(join(root, entry));
      return true;
    } catch {
      return false;
    }
  }).sort();
}

function completeVersion(version: string): boolean {
  try {
    return inspectInstalledVersion(version).complete;
  } catch {
    return false;
  }
}

function reservationRoot(): string {
  return join(installRoot(), "reservations");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reservedVersions(): Set<string> {
  const reserved = new Set<string>();
  const root = reservationRoot();
  if (!existsSync(root)) return reserved;
  for (const entry of readdirSync(root)) {
    const match = /^(\d+\.\d+\.\d+)-(\d+)-[a-f0-9-]+$/.exec(entry);
    const path = join(root, entry);
    if (!match || !lstatSync(path).isFile()) {
      reserved.add("*");
      continue;
    }
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !processIsAlive(pid)) {
      rmSync(path, { force: true });
      continue;
    }
    reserved.add(match[1]);
  }
  return reserved;
}

function reserveVersion(
  version: string,
  options: { requireComplete?: boolean } = {},
): () => void {
  const root = machineTransactionRoot();
  const path = join(
    reservationRoot(),
    `${requireVersion(version)}-${process.pid}-${randomUUID()}`,
  );
  executePlan({
    schemaVersion: 1,
    root,
    operations: [writeOperation(
      relative(root, path),
      `${JSON.stringify({ version, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "absent",
      0o600,
    )],
  }, {
    validateLocked: options.requireComplete
      ? () => {
          const inspection = inspectInstalledVersion(version);
          if (!inspection.complete) {
            commandError(
              `cannot reserve incomplete retained version ${version}: ${
                inspection.reason ?? "integrity validation failed"
              }`,
              EXIT.integrity,
            );
          }
        }
      : undefined,
  });
  return () => {
    rmSync(path, { force: true });
    try {
      if (existsSync(reservationRoot()) && readdirSync(reservationRoot()).length === 0) {
        rmdirSync(reservationRoot());
      }
    } catch {
      // Stale reservations fail toward retention and are reaped by the next scan.
    }
  };
}

export function reserveDispatchedVersion(version: string): () => void {
  return reserveVersion(version, { requireComplete: true });
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function requireConfirmation(argv: readonly string[], message: string): void {
  if (argv.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    commandError(`${message}; non-interactive use requires --yes`, EXIT.usage);
  }
  const answer = prompt(`${message}\nContinue [y/N]:`);
  if (!/^y(?:es)?$/i.test(answer?.trim() ?? "")) {
    commandError("operation cancelled", EXIT.failure);
  }
}

function windowsLauncherOwnedByInstaller(): boolean {
  try {
    const helper = readFileSync(windowsShimPath(), "utf-8");
    return readFileSync(commandPath(), "utf-8") === windowsShim() &&
      (helper === windowsShimHelper() || helper === legacyWindowsShimHelper());
  } catch {
    return false;
  }
}

function unixLauncherOwnedByInstaller(): boolean {
  try {
    return lstatSync(commandPath()).isFile() &&
      readFileSync(commandPath(), "utf-8") === unixShim();
  } catch {
    return false;
  }
}

function commandOwnedByInstaller(version: string): boolean {
  try {
    if (process.platform === "win32") {
      return windowsLauncherOwnedByInstaller() &&
        readActiveExecutable() === resolve(installedExecutablePath(version));
    }
    if (
      lstatSync(commandPath()).isSymbolicLink() &&
      realpathSync(commandPath()) === realpathSync(installedExecutablePath(version))
    ) {
      return true;
    }
    return unixLauncherOwnedByInstaller() &&
      readActiveExecutable() === resolve(installedExecutablePath(version));
  } catch {
    return false;
  }
}

function readPinRegistry(
  strict = false,
  reconcileProject?: string,
): {
  pins: Record<string, string>;
  warnings: string[];
} {
  const path = join(installRoot(), "pins.json");
  if (!existsSync(path)) return { pins: {}, warnings: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const warning = `${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    if (strict) commandError(warning, EXIT.integrity);
    return { pins: {}, warnings: [warning] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const warning = `${path} must contain a project-to-version object`;
    if (strict) commandError(warning, EXIT.integrity);
    return { pins: {}, warnings: [warning] };
  }
  const pins: Record<string, string> = {};
  const warnings: string[] = [];
  const conflicted = new Set<string>();
  for (const [project, version] of Object.entries(value as Record<string, unknown>)) {
    if (!isAbsolute(project) || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      warnings.push(`${path} contains an invalid pin entry for ${project}`);
      continue;
    }
    let canonical: string;
    try {
      canonical = canonicalProjectPath(project);
    } catch (error) {
      warnings.push(
        `${path} cannot resolve pin entry for ${project}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (conflicted.has(canonical)) continue;
    const existing = pins[canonical];
    if (existing === undefined || existing === version) {
      pins[canonical] = version;
      continue;
    }
    if (canonical === reconcileProject) {
      pins[canonical] = version;
      continue;
    }
    delete pins[canonical];
    conflicted.add(canonical);
    warnings.push(
      `${path} contains conflicting equivalent pin entries for ${canonical}`,
    );
  }
  if (strict && warnings.length > 0) commandError(warnings.join("; "), EXIT.integrity);
  return { pins, warnings };
}

function canonicalProjectPath(projectDir: string): string {
  return canonicalPolicyPath(projectDir);
}

function projectPinRecordsMatch(projectDir: string, version: string): boolean {
  try {
    const pinPath = join(projectDir, ".aidlc-version");
    return existsSync(pinPath) &&
      statSync(pinPath).isFile() &&
      readFileSync(pinPath, "utf-8").trim() === version &&
      inspectProjectPinTarget(projectDir, version).valid;
  } catch {
    return false;
  }
}

function registeredPins(strict = false): {
  pins: Record<string, string>;
  warnings: string[];
} {
  const { pins: rawPins, warnings } = readPinRegistry(strict);
  const pins: Record<string, string> = {};
  for (const [project, version] of Object.entries(rawPins)) {
    if (existsSync(project) && !projectPinRecordsMatch(project, version)) continue;
    pins[project] = version;
  }
  return { pins, warnings };
}

function commitProjectPin(projectDir: string, version: string | null): void {
  const project = canonicalProjectPath(projectDir);
  const pinPath = join(projectDir, ".aidlc-version");
  const targetPath = projectPinTargetPath(projectDir);
  const registryPath = join(installRoot(), "pins.json");
  const pins = readPinRegistry(true, project).pins;
  delete pins[project];
  if (version !== null) pins[project] = version;

  const projectOperations = version === null
    ? [
        ...(existsSync(pinPath)
          ? [{
              kind: "remove" as const,
              path: ".aidlc-version",
              expected: transactionState(pinPath) as string,
            }]
          : []),
        ...(existsSync(targetPath)
          ? [{
              kind: "remove" as const,
              path: relative(projectDir, targetPath),
              expected: transactionState(targetPath) as string,
            }]
          : []),
      ]
    : [
        writeOperation(
          ".aidlc-version",
          `${version}\n`,
          transactionState(pinPath),
        ),
        writeOperation(
          relative(projectDir, targetPath),
          `${resolve(installedExecutablePath(version))}\n`,
          transactionState(targetPath),
          0o600,
        ),
      ];

  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: [writeOperation(
      relative(root, registryPath),
      `${JSON.stringify(pins, null, 2)}\n`,
      transactionState(registryPath),
      0o600,
    )],
  }, {
    validateLocked: () => {
      if (version === null) return;
      const inspection = inspectInstalledVersion(version, projectDistribution(projectDir));
      if (!inspection.complete) {
        commandError(
          `retained version ${version} became incomplete before the pin commit: ${
            inspection.reason ?? "integrity validation failed"
          }`,
          EXIT.integrity,
        );
      }
    },
    validateCommitted: () => {
      if (projectOperations.length === 0) return;
      executePlan({
        schemaVersion: 1,
        root: projectDir,
        operations: projectOperations,
      });
    },
  });
}

export type PinnedDispatchResult =
  | { kind: "none" }
  | {
      kind: "failure";
      code: number;
      message: string;
      remediation: string;
    }
  | { kind: "execute"; executable: string; version: string };

function completePinnedVersion(
  version: string,
  distribution: string | null,
): boolean {
  try {
    return inspectInstalledVersion(version, distribution).complete;
  } catch {
    return false;
  }
}

export function resolvePinnedDispatch(
  argv: string[],
): PinnedDispatchResult {
  const projectDir = projectDirFrom(argv);
  const pinPath = join(projectDir, ".aidlc-version");
  if (!existsSync(pinPath)) return { kind: "none" };
  const version = readFileSync(pinPath, "utf-8").trim();
  if (!STRICT_SEMVER.test(version)) {
    return {
      kind: "failure",
      code: EXIT.usage,
      message: `${pinPath} must contain one strict semver`,
      remediation: "aidlc config --unpin",
    };
  }
  const remediation = `aidlc config --pin ${version}`;
  const registry = readPinRegistry();
  if (registry.warnings.length > 0) {
    return {
      kind: "failure",
      code: EXIT.integrity,
      message: `this project's pin registry is invalid: ${registry.warnings.join("; ")}`,
      remediation,
    };
  }
  const project = canonicalProjectPath(projectDir);
  if (registry.pins[project] !== version) {
    return {
      kind: "failure",
      code: EXIT.failure,
      message: `this project's ${version} pin is not registered on this machine`,
      remediation,
    };
  }
  const target = inspectProjectPinTarget(projectDir, version);
  if (!target.valid) {
    return {
      kind: "failure",
      code: EXIT.failure,
      message: `this project's ${version} pin target is invalid: ${
        target.reason ?? "resolved target validation failed"
      }`,
      remediation,
    };
  }
  const distribution = projectDistribution(projectDir);
  if (!completePinnedVersion(version, distribution)) {
    return {
      kind: "failure",
      code: EXIT.failure,
      message: `this project requires ${version}, which is not installed completely`,
      remediation,
    };
  }
  if (process.env.AIDLC_PIN_DISPATCHED === version) return { kind: "none" };
  if (version === AIDLC_VERSION) return { kind: "none" };
  return {
    kind: "execute",
    executable: target.target,
    version,
  };
}

function lifecycleFailureResult(error: unknown, argv: readonly string[]): CommandResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LifecycleCommandError
    ? error.exitCode
    : error instanceof ReleaseUnavailableError
    ? EXIT.unavailable
    : /mutation scope cannot mutate/.test(message)
    ? EXIT.integrity
    : valueAfter(argv, "--from") &&
        /(checksum|version\.json|checksums\.txt|release is missing|invalid asset|size mismatch)/i
          .test(message)
    ? EXIT.integrity
    : EXIT.failure;
  return failure(message, code);
}

function treesMatch(left: string, right: string): boolean {
  const leftFiles = walkFiles(left).map((path) => path.replaceAll("\\", "/"));
  const rightFiles = walkFiles(right).map((path) => path.replaceAll("\\", "/"));
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  return leftFiles.every((path) =>
    sha256File(join(left, path)) === sha256File(join(right, path)) &&
    (statSync(join(left, path)).mode & 0o777) === (statSync(join(right, path)).mode & 0o777)
  );
}

function retainedVersions(): {
  versions: Array<{
    version: string;
    active: boolean;
    rollback: boolean;
    distributions: string[];
    complete: boolean;
    reserved: boolean;
    pinPaths: string[];
    stalePinPaths: string[];
  }>;
  pinWarnings: string[];
} {
  const { pins, warnings } = registeredPins();
  if (!existsSync(versionsRoot())) return { versions: [], pinWarnings: warnings };
  const active = activeVersion();
  const reservations = reservedVersions();
  const rollback = existsSync(rollbackVersionPath())
    ? readFileSync(rollbackVersionPath(), "utf-8").trim()
    : null;
  const versions = readdirSync(versionsRoot()).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)).sort()
    .map((version) => ({
      version,
      active: version === active,
      rollback: version === rollback,
      distributions: installedDistributions(version),
      complete: completeVersion(version),
      reserved: reservations.has("*") || reservations.has(version),
      pinPaths: Object.entries(pins)
        .filter(([project, pinnedVersion]) => pinnedVersion === version && existsSync(project))
        .map(([project]) => project)
        .sort(),
      stalePinPaths: Object.entries(pins)
        .filter(([project, pinnedVersion]) => pinnedVersion === version && !existsSync(project))
        .map(([project]) => project)
        .sort(),
    }));
  return { versions, pinWarnings: warnings };
}

function assertVersionsRemainPrunable(versions: readonly string[]): void {
  const refreshed = retainedVersions();
  if (refreshed.pinWarnings.length > 0) {
    commandError(
      `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
      EXIT.integrity,
    );
  }
  const current = new Map(refreshed.versions.map((item) => [item.version, item]));
  const protectedVersions = versions.filter((version) => {
    const item = current.get(version);
    return !item ||
      item.active ||
      item.rollback ||
      item.reserved ||
      item.pinPaths.length > 0 ||
      item.stalePinPaths.length > 0;
  });
  if (protectedVersions.length > 0) {
    commandError(
      `prune cancelled because version protection changed: ${protectedVersions.join(", ")}`,
      EXIT.failure,
    );
  }
}

function projectDistribution(projectDir: string): string | null {
  const harnessDir = runtimeHarnessDir(projectDir);
  return discoverProjectHarnesses(projectDir)
    .find((candidate) => candidate.harnessDir === harnessDir)?.distribution ?? null;
}

function activateReserved(version: string, options: { failAfter?: number } = {}): void {
  if (!completeVersion(version)) {
    commandError(`retained version ${version} is incomplete`, EXIT.unavailable);
  }
  const previous = activeVersion();
  const root = machineTransactionRoot();
  const target = installedExecutablePath(version);
  const windows = process.platform === "win32";
  const shim = windows ? windowsShim() : unixShim();
  const shimHelper = windows ? windowsShimHelper() : null;
  if (
    pathEntryExists(commandPath()) &&
    (!previous ||
      !(windows
        ? windowsLauncherOwnedByInstaller()
        : commandOwnedByInstaller(previous)))
  ) {
    commandError(
      `existing ${commandPath()} is not owned by this AI-DLC install`,
      EXIT.integrity,
    );
  }
  if (windows && existsSync(commandPath()) && readFileSync(commandPath(), "utf-8") !== shim) {
    commandError("existing aidlc.cmd is not owned by this AI-DLC install", EXIT.integrity);
  }
  if (
    windows &&
    existsSync(windowsShimPath()) &&
    ![shimHelper, legacyWindowsShimHelper()].includes(
      readFileSync(windowsShimPath(), "utf-8"),
    )
  ) {
    commandError("existing aidlc-shim.ps1 is not owned by this AI-DLC install", EXIT.integrity);
  }
  const operations = [
    ...(previous && previous !== version
      ? [writeOperation(relative(root, rollbackVersionPath()), `${previous}\n`,
          transactionState(rollbackVersionPath()))]
      : []),
    writeOperation(
      relative(root, activeVersionPath()),
      `${version}\n`,
      transactionState(activeVersionPath()),
    ),
    ...(windows
      ? [
          writeOperation(
            relative(root, windowsShimPath()),
            shimHelper as string,
            transactionState(windowsShimPath()),
            0o700,
          ),
          ...(!existsSync(commandPath())
            ? [writeOperation(
                relative(root, commandPath()),
                shim,
                "absent",
                0o700,
              )]
            : []),
        ]
      : [writeOperation(
          relative(root, commandPath()),
          shim,
          transactionState(commandPath()),
          0o700,
        )]),
    writeOperation(
      relative(root, activeExecutablePath()),
      `${target}${windows ? "\r\n" : "\n"}`,
      transactionState(activeExecutablePath()),
      0o600,
    ),
    ...(Object.entries(COMPLETION_FILES) as Array<[Shell, string]>)
      .map(([shell, file]) => {
        const path = join(installRoot(), "completions", file);
        return writeOperation(
          relative(root, path),
          renderCompletion(shell),
          transactionState(path),
          0o644,
        );
      }),
  ];
  executePlan({
    schemaVersion: 1,
    root,
    operations,
  }, {
    ...options,
    validateLocked: () => {
      const inspection = inspectInstalledVersion(version);
      if (!inspection.complete) {
        commandError(
          `retained version ${version} became incomplete before activation: ${
            inspection.reason ?? "integrity validation failed"
          }`,
          EXIT.integrity,
        );
      }
    },
    validateCommitted: () => {
      if (
        readActiveExecutable() !== resolve(target) ||
        (windows
          ? !windowsLauncherOwnedByInstaller()
          : !unixLauncherOwnedByInstaller())
      ) {
        throw new Error(`command pointer validation failed for ${version}`);
      }
      const probe = Bun.spawnSync([commandPath(), "version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Buffer.from(probe.stdout ?? new Uint8Array()).toString("utf-8").trim();
      if (probe.exitCode !== 0 || output !== `aidlc ${version} (runtime ${version})`) {
        throw new Error(
          `command pointer validation failed for ${version}: version probe returned ${
            probe.exitCode ?? "no exit"
          } ${JSON.stringify(output)}`,
        );
      }
    },
  });
}

export function activate(version: string, options: { failAfter?: number } = {}): void {
  const releaseReservation = reserveVersion(version);
  try {
    activateReserved(version, options);
  } finally {
    releaseReservation();
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function unixShim(): string {
  const pointer = shellSingleQuote(activeExecutablePath());
  const versionPointer = shellSingleQuote(activeVersionPath());
  const versions = shellSingleQuote(versionsRoot());
  return [
    "#!/bin/sh",
    "# aidlc-native-launcher-v2",
    `active_pointer=${pointer}`,
    `active_version_pointer=${versionPointer}`,
    `versions_root=${versions}`,
    "read_one_line() {",
    "  line=",
    "  extra=",
    "  {",
    "    IFS= read -r line || [ -n \"$line\" ] || return 1",
    "    if IFS= read -r extra; then return 1; fi",
    "  } < \"$1\"",
    "  [ -n \"$line\" ] || return 1",
    "  return 0",
    "}",
    "valid_number() {",
    "  case \"$1\" in ''|*[!0-9]*) return 1 ;; 0) return 0 ;; 0*) return 1 ;; *) return 0 ;; esac",
    "}",
    "valid_version() {",
    "  version_value=$1",
    "  case \"$version_value\" in *[!0-9.]*|'') return 1 ;; esac",
    "  old_ifs=$IFS",
    "  IFS=.",
    "  set -- $version_value",
    "  IFS=$old_ifs",
    "  [ \"$#\" -eq 3 ] && valid_number \"$1\" && valid_number \"$2\" && valid_number \"$3\"",
    "}",
    "if ! read_one_line \"$active_version_pointer\" || ! valid_version \"$line\"; then",
    "  printf 'aidlc: active version marker is missing or malformed\\n' >&2",
    "  printf 'Run: aidlc update --version <version> --from <release-directory>\\n' >&2",
    "  exit 4",
    "fi",
    "active_version=$line",
    "if ! read_one_line \"$active_pointer\"; then",
    "  printf 'aidlc: active command target is missing or malformed\\n' >&2",
    "  printf 'Run: aidlc update --version <version> --from <release-directory>\\n' >&2",
    "  exit 4",
    "fi",
    "target=$line",
    "expected=$versions_root/$active_version/aidlc",
    "if [ \"$target\" != \"$expected\" ] || [ ! -f \"$target\" ] || [ ! -x \"$target\" ]; then exit 4; fi",
    "exec \"$target\" \"$@\"",
    "",
  ].join("\n");
}

function windowsShim(): string {
  const helper = windowsShimPath().replaceAll("%", "%%");
  return [
    "@echo off",
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${helper}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function windowsShimPath(): string {
  return join(installRoot(), "aidlc-shim.ps1");
}

function windowsShimHelper(): string {
  const pointer = activeExecutablePath().replaceAll("'", "''");
  const versionPointer = activeVersionPath().replaceAll("'", "''");
  const root = versionsRoot().replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$pointer = '${pointer}'`,
    `$versionPointer = '${versionPointer}'`,
    `$versions = [IO.Path]::GetFullPath('${root}')`,
    "try {",
    "  $versionRaw = [IO.File]::ReadAllText($versionPointer)",
    "  if ($versionRaw -notmatch '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\r?\\n?$') { exit 4 }",
    "  $activeVersion = $versionRaw.TrimEnd(\"`r\", \"`n\")",
    "  $raw = [IO.File]::ReadAllText($pointer)",
    "  if ($raw -notmatch '^[^\\r\\n]+\\r?\\n?$') { exit 4 }",
    "  $executable = [IO.Path]::GetFullPath($raw.TrimEnd(\"`r\", \"`n\"))",
    "  $expected = [IO.Path]::Combine($versions, $activeVersion, 'aidlc.exe')",
    "  if (-not $executable.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { exit 4 }",
    "  if (-not [IO.File]::Exists($executable)) { exit 4 }",
    "  $env:AIDLC_SHIM_PID = [string]$PID",
    "  & $executable @args",
    "  exit $LASTEXITCODE",
    "} catch {",
    "  exit 4",
    "}",
    "",
  ].join("\r\n");
}

function legacyWindowsShimHelper(): string {
  const pointer = activeExecutablePath().replaceAll("'", "''");
  const root = versionsRoot().replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$pointer = '${pointer}'`,
    `$versions = [IO.Path]::GetFullPath('${root}')`,
    "try {",
    "  $raw = [IO.File]::ReadAllText($pointer)",
    "  if ($raw -notmatch '^[^\\r\\n]+\\r?\\n?$') { exit 4 }",
    "  $executable = [IO.Path]::GetFullPath($raw.TrimEnd(\"`r\", \"`n\"))",
    "  $prefix = $versions.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "  if (-not $executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { exit 4 }",
    "  $relative = $executable.Substring($prefix.Length)",
    "  if ($relative -notmatch '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\\\aidlc\\.exe$') { exit 4 }",
    "  if (-not [IO.File]::Exists($executable)) { exit 4 }",
    "  $env:AIDLC_SHIM_PID = [string]$PID",
    "  & $executable @args",
    "  exit $LASTEXITCODE",
    "} catch {",
    "  exit 4",
    "}",
    "",
  ].join("\r\n");
}

async function installVersion(options: {
  version?: string;
  from?: string;
  offline?: boolean;
  activate: boolean;
  dryRun: boolean;
  baseUrl?: string;
  caBundle?: string;
}): Promise<{ version: string; distributions: string[] }> {
  const wantedVersion = options.version ? requestedVersion(options.version) : undefined;
  const target = targetTriple();
  const required = [binaryAsset(target), RUNTIME_ASSET];
  const release = await acquireRelease({
    version: wantedVersion,
    from: options.from,
    names: required,
    offline: options.offline,
    baseUrl: options.baseUrl,
    caBundle: options.caBundle,
  });
  const version = release.manifest.version;
  const releaseReservation = options.dryRun ? null : reserveVersion(version);
  const temporary = mkdtempSync(join(tmpdir(), `aidlc-version-${version}-`));
  try {
    const candidate = join(temporary, version);
    mkdirSync(join(candidate, "runtime"), { recursive: true });
    const binarySource = join(release.directory, binaryAsset(target));
    const candidateExecutable = join(
      candidate,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    writeFileSync(candidateExecutable, readFileSync(binarySource), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(candidateExecutable, 0o755);
    extractTarGz(join(release.directory, RUNTIME_ASSET), candidate, {
      reservedTopLevelNames: ["aidlc", "aidlc.exe"],
    });
    const distributions = release.manifest.distributions.map((item) => item.name).sort();
    for (const distribution of distributions) {
      const root = join(candidate, "runtime", distribution);
      const { stamp } = projectionFiles(root);
      if (stamp.frameworkVersion !== version || stamp.distribution !== distribution) {
        throw new Error(`${distribution} runtime stamp does not match release ${version}`);
      }
    }
    const baselinePath = join(candidate, basename(runtimeIntegrityPath(version)));
    writeFileSync(
      baselinePath,
      `${JSON.stringify(
        createRuntimeIntegrity(version, join(candidate, "runtime")),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(candidate, "version.json"),
      `${JSON.stringify({
        ...release.manifest,
        installedRuntime: {
          schemaVersion: 1,
          baseline: basename(baselinePath),
          sha256: sha256File(baselinePath),
        },
      }, null, 2)}\n`,
    );
    if (!options.dryRun) {
      const destination = versionRoot(version);
      if (existsSync(destination)) {
        const priorManifestPath = join(destination, "version.json");
        if (!existsSync(priorManifestPath)) {
          commandError(`existing ${version} install has no release manifest`, EXIT.integrity);
        }
        const priorManifest = JSON.parse(readFileSync(priorManifestPath, "utf-8")) as {
          assets?: Array<{ name: string; sha256: string }>;
        };
        const expectedAssets = new Map(
          release.manifest.assets.map((asset) => [asset.name, asset.sha256]),
        );
        for (const assetName of required) {
          const prior = priorManifest.assets?.find((asset) => asset.name === assetName);
          if (!prior || prior.sha256 !== expectedAssets.get(assetName)) {
            commandError(
              `existing ${version} install came from a different ${assetName}`,
              EXIT.integrity,
            );
          }
        }
        if (digest(installedExecutablePath(version)) !== expectedAssets.get(binaryAsset(target))) {
          commandError(
            `existing ${version} binary does not match the verified release`,
            EXIT.integrity,
          );
        }
        if (!treesMatch(join(destination, "runtime"), join(candidate, "runtime"))) {
          commandError(
            `existing ${version} runtime does not match the verified release`,
            EXIT.integrity,
          );
        }
        if (!completeVersion(version)) {
          commandError(`existing ${version} install is incomplete`, EXIT.integrity);
        }
      } else {
        executePlan({
          schemaVersion: 1,
          root: machineTransactionRoot(),
          operations: [{
            kind: "tree",
            path: relative(machineTransactionRoot(), destination),
            source: candidate,
            sourceHash: transactionSourceHash(candidate),
            expected: "absent",
          }],
        });
      }
      if (options.activate) activate(version);
    }
    return { version, distributions };
  } finally {
    releaseReservation?.();
    rmSync(temporary, { recursive: true, force: true });
    if (release.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
  }
}

async function versionsCommand(argv: string[]): Promise<ReturnType<typeof success>> {
  const verb = argv[1];
  if (verb === "list") {
    const { versions, pinWarnings } = retainedVersions();
    if (argv.includes("--completion-values")) {
      return success(
        versions.filter((item) => item.complete).map((item) => item.version).join("\n"),
      );
    }
    return success(
      (versions.length
        ? versions.map((item) =>
            `${item.version}${item.active ? " active" : ""}${item.rollback ? " rollback" : ""} [${item.distributions.join(",")}] pins=${item.pinPaths.length} stale-pins=${item.stalePinPaths.length}${item.complete ? "" : " incomplete"}`
          ).join("\n")
        : "no retained versions") +
        (pinWarnings.length > 0 ? `\nwarning: ${pinWarnings.join("; ")}` : ""),
      { versions, pinWarnings },
    );
  }
  if (verb === "prune") {
    const { versions, pinWarnings } = retainedVersions();
    if (pinWarnings.length > 0) {
      commandError(
        `cannot prune while pin registry is invalid: ${pinWarnings.join("; ")}`,
        EXIT.integrity,
      );
    }
    const protectedVersions = versions.filter((item) =>
      item.active ||
      item.rollback ||
      item.reserved ||
      item.pinPaths.length > 0 ||
      item.stalePinPaths.length > 0
    );
    const removable = versions.filter((item) => !protectedVersions.includes(item));
    const protection = protectedVersions.map((item) => {
      const reasons = [
        ...(item.active ? ["active"] : []),
        ...(item.rollback ? ["rollback"] : []),
        ...(item.reserved ? ["in use"] : []),
        ...item.pinPaths.map((path) => `pinned by ${path}`),
        ...item.stalePinPaths.map((path) => `stale pin ${path}`),
      ];
      return `${item.version} (${reasons.join(", ")})`;
    }).join("; ");
    if (removable.length === 0) {
      return success(
        protection
          ? `no versions eligible for pruning; protected: ${protection}`
          : "no versions eligible for pruning",
        { removed: [], protected: protectedVersions },
      );
    }
    requireConfirmation(
      argv,
      `Prune retained versions ${removable.map((item) => item.version).join(", ")}?`,
    );
    const refreshed = retainedVersions();
    if (refreshed.pinWarnings.length > 0) {
      commandError(
        `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
        EXIT.failure,
      );
    }
    const refreshedByVersion = new Map(
      refreshed.versions.map((item) => [item.version, item]),
    );
    const newlyProtected = removable.filter((item) => {
      const current = refreshedByVersion.get(item.version);
      return !current ||
        current.active ||
        current.rollback ||
        current.reserved ||
        current.pinPaths.length > 0 ||
        current.stalePinPaths.length > 0;
    });
    if (newlyProtected.length > 0) {
      commandError(
        `prune cancelled because version protection changed: ${
          newlyProtected.map((item) => item.version).join(", ")
        }`,
        EXIT.failure,
      );
    }
    const root = machineTransactionRoot();
    executePlan({
      schemaVersion: 1,
      root,
      operations: removable.map((item) => ({
        kind: "remove" as const,
        path: relative(root, versionRoot(item.version)),
        expected: transactionState(versionRoot(item.version)) as string,
      })),
    }, {
      validateLocked: () =>
        assertVersionsRemainPrunable(removable.map((item) => item.version)),
    });
    return success(
      `pruned ${removable.map((item) => item.version).join(", ")}${
        protection ? `; protected: ${protection}` : ""
      }`,
      { removed: removable.map((item) => item.version), protected: protectedVersions },
    );
  }
  if (verb !== "install") return usage("usage: aidlc system versions <list|install|prune>");
  const version = argv[2];
  if (!version || version.startsWith("--")) return usage("versions install requires a strict version");
  if (argv.includes("--harness")) return usage("unknown argument: --harness");
  const result = await installVersion({
    version,
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: false,
    dryRun: argv.includes("--dry-run"),
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  return success(
    `installed ${result.version} side-by-side; active version remains ${activeVersion() ?? "unchanged"}`,
    result,
  );
}

function pruneUnprotectedVersions(): string[] {
  const { versions, pinWarnings } = retainedVersions();
  if (pinWarnings.length > 0) {
    commandError(
      `cannot prune while pin registry is invalid: ${pinWarnings.join("; ")}`,
      EXIT.integrity,
    );
  }
  const removable = versions.filter((item) =>
    !item.active &&
    !item.rollback &&
    !item.reserved &&
    item.pinPaths.length === 0 &&
    item.stalePinPaths.length === 0
  );
  if (removable.length === 0) return [];
  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: removable.map((item) => ({
      kind: "remove" as const,
      path: relative(root, versionRoot(item.version)),
      expected: transactionState(versionRoot(item.version)) as string,
    })),
  }, {
    validateLocked: () =>
      assertVersionsRemainPrunable(removable.map((item) => item.version)),
  });
  return removable.map((item) => item.version);
}

function removeEmptyInstallerDirectory(path: string): void {
  try {
    if (
      existsSync(path) &&
      lstatSync(path).isDirectory() &&
      readdirSync(path).length === 0
    ) {
      rmdirSync(path);
    }
  } catch {
    // Non-empty or concurrently reused directories are preserved.
  }
}

function uninstallCommand(argv: string[]): CommandResult {
  const executable = compiledExecutable();
  const manager = executable ? packageManagerForExecutable(executable) : null;
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-uninstall is disabled`,
      EXIT.integrity,
      manager.remediation,
    );
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return failure("refusing to uninstall a root-owned installation", EXIT.integrity);
  }
  const purge = argv.includes("--purge");
  if (process.platform === "win32") {
    const recovered = recoverWindowsUninstallContinuations(purge);
    if (recovered > 0) {
      return success(
        `resumed ${recovered} pending Windows uninstall continuation(s)`,
        { purge, deferred: true, recovered },
      );
    }
  }
  const version = activeVersion();
  if (!version || !completeVersion(version)) {
    return failure(
      "no complete native AI-DLC installation is active",
      EXIT.unavailable,
    );
  }
  if (!commandOwnedByInstaller(version)) {
    return failure(
      `existing ${commandPath()} is not owned by this AI-DLC install`,
      EXIT.integrity,
    );
  }
  const reservations = reservedVersions();
  if (reservations.size > 0) {
    return failure(
      "cannot uninstall while a retained AI-DLC version is in use",
      EXIT.failure,
      "wait for running AI-DLC commands to exit, then retry",
    );
  }
  const { versions } = retainedVersions();
  const preserved = purge ? "nothing" : "global config, update cache, pins, and harness default";
  requireConfirmation(
    argv,
    `Uninstall AI-DLC (${versions.length} retained version(s))? Project trees will not be changed; preserving ${preserved}.`,
  );
  if (process.platform === "win32") {
    return scheduleWindowsUninstall(purge);
  }
  const root = machineTransactionRoot();
  const paths = [
    commandPath(),
    versionsRoot(),
    join(installRoot(), "completions"),
    reservationRoot(),
    activeVersionPath(),
    rollbackVersionPath(),
    activeExecutablePath(),
    ...(purge
      ? [
          machineConfigPath(),
          updateCachePath(),
          join(installRoot(), "pins.json"),
          defaultHarnessPath(),
        ]
      : []),
  ].filter(existsSync);
  executePlan({
    schemaVersion: 1,
    root,
    operations: paths.map((path) => ({
      kind: "remove" as const,
      path: relative(root, path),
      expected: transactionState(path) as string,
    })),
  });
  const resolvedInstallRoot = resolve(installRoot());
  const resolvedBinRoot = resolve(binRoot());
  if (
    resolvedBinRoot !== resolvedInstallRoot &&
    resolvedBinRoot.startsWith(`${resolvedInstallRoot}${sep}`)
  ) {
    removeEmptyInstallerDirectory(resolvedBinRoot);
  }
  if (purge) removeEmptyInstallerDirectory(resolvedInstallRoot);
  return success(
    `uninstalled AI-DLC; ${purge ? "removed machine configuration and cache" : "preserved machine configuration and cache"}`,
    { purge, preserved: purge ? [] : ["config", "update-cache", "pins", "default-harness"] },
  );
}

function scheduleWindowsUninstall(purge: boolean): CommandResult {
  const preserved = [
    machineConfigPath(),
    updateCachePath(),
    join(installRoot(), "pins.json"),
    defaultHarnessPath(),
  ];
  scheduleWindowsUninstallContinuation(purge, preserved);
  return success(
    `uninstall scheduled; Windows cleanup will finish after this command exits`,
    { purge, deferred: true },
  );
}

async function updateCommand(argv: string[]): Promise<CommandResult> {
  const executable = compiledExecutable();
  const manager = executable ? packageManagerForExecutable(executable) : null;
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-update is disabled`,
      EXIT.failure,
      manager.remediation,
    );
  }
  const current = activeVersion();
  if (argv.includes("--harness")) return usage("unknown argument: --harness");
  if (argv.includes("--check")) {
    let state: Awaited<ReturnType<typeof refreshUpdateState>>;
    try {
      state = await refreshUpdateState(15_000, {
        offline: offline(argv),
        baseUrl: valueAfter(argv, "--release-base-url"),
        caBundle: valueAfter(argv, "--ca-bundle"),
      });
    } catch (error) {
      commandError(
        error instanceof Error ? error.message : String(error),
        error instanceof ReleaseUnavailableError ? EXIT.unavailable : EXIT.failure,
      );
    }
    if (state.state === "behind") {
      return {
        ...success(state.message, state),
        code: EXIT.actionNeeded,
        status: "action-needed",
      };
    }
    if (state.state === "invalid-config") {
      return failure(state.message, EXIT.usage, "repair or remove the invalid machine config");
    }
    if (
      state.state === "unavailable" ||
      state.state === "offline"
    ) {
      return failure(state.message, EXIT.unavailable);
    }
    if (state.state === "disabled") {
      return failure(state.message, EXIT.failure);
    }
    return success(state.message, state);
  }
  const dryRun = argv.includes("--dry-run");
  const result = await installVersion({
    version: valueAfter(argv, "--version"),
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: true,
    dryRun,
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  let pruned: string[] = [];
  let pruneWarning: string | undefined;
  if (!dryRun) {
    try {
      pruned = pruneUnprotectedVersions();
    } catch (error) {
      pruneWarning = error instanceof Error ? error.message : String(error);
    }
  }
  return success(
    dryRun
      ? `update plan: ${current ?? "none"} -> ${result.version} [${result.distributions.join(",")}]`
      : `updated ${current ?? "new install"} -> ${result.version}${
        pruned.length > 0 ? `; pruned ${pruned.join(", ")}` : ""
      }`,
    { ...result, pruned, ...(pruneWarning ? { pruneWarning } : {}) },
  );
}

function rollbackCommand(argv: string[]): ReturnType<typeof success> {
  if (argv.includes("--list")) {
    const { versions, pinWarnings } = retainedVersions();
    const eligible = versions.filter((item) => item.complete && !item.active);
    return success(
      (eligible.length
        ? eligible.map((item) => `${item.version} [${item.distributions.join(",")}]`).join("\n")
        : "no rollback target") +
        (pinWarnings.length > 0 ? `\nwarning: ${pinWarnings.join("; ")}` : ""),
      { versions: eligible, pinWarnings },
    );
  }
  const target = valueAfter(argv, "--version") ||
    (existsSync(rollbackVersionPath()) ? readFileSync(rollbackVersionPath(), "utf-8").trim() : "");
  if (!target) {
    commandError("no prior version is recorded; run aidlc use <version>", EXIT.failure);
  }
  if (valueAfter(argv, "--version")) {
    requestedVersion(target);
  } else {
    try {
      requireVersion(target);
    } catch (error) {
      commandError(
        `recorded rollback version is invalid: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.integrity,
      );
    }
  }
  const active = activeVersion();
  const missing = active
    ? installedDistributions(active).filter((item) => !installedDistributions(target).includes(item))
    : [];
  if (missing.length > 0 && !argv.includes("--allow-harness-loss")) {
    throw new Error(`rollback target lacks harnesses: ${missing.join(", ")}`);
  }
  activate(target);
  return success(`rolled back to ${target}`, { version: target });
}

export async function configureProjectPin(argv: string[]): Promise<CommandResult> {
  try {
    const hasPin = argv.includes("--pin");
    const hasUnpin = argv.includes("--unpin");
    if (hasPin === hasUnpin) {
      return usage("usage: aidlc config --pin <version> | aidlc config --unpin");
    }
    if (argv.includes("--harness")) return usage("unknown argument: --harness");
    const projectDir = projectDirFrom(argv);
    const responseProjectDir = canonicalProjectPath(projectDir);
    const dryRun = argv.includes("--dry-run");
    if (hasUnpin) {
      if (dryRun) {
        return success(
          "Project pin removal plan; no files were changed.",
          {
            projectDir: responseProjectDir,
            version: activeVersion(),
            pinned: false,
            dryRun: true,
          },
        );
      }
      commitProjectPin(projectDir, null);
      return success(
        "Removed this project's AI-DLC version pin; it now follows the active machine version.",
        { projectDir: responseProjectDir, version: activeVersion(), pinned: false },
      );
    }
    const requested = valueAfter(argv, "--pin");
    if (!requested) return usage("--pin requires a strict version");
    const version = requestedVersion(requested);
    const releaseReservation = dryRun ? null : reserveVersion(version);
    try {
      if (existsSync(versionRoot(version)) && !completeVersion(version)) {
        const reason = inspectInstalledVersion(version).reason ?? "integrity validation failed";
        commandError(`retained version ${version} is incomplete: ${reason}`, EXIT.integrity);
      }
      let distributions = completeVersion(version)
        ? installedDistributions(version)
        : null;
      if (!distributions) {
        const planned = await installVersion({
          version,
          from: valueAfter(argv, "--from"),
          offline: offline(argv),
          activate: false,
          dryRun,
          baseUrl: valueAfter(argv, "--release-base-url"),
          caBundle: valueAfter(argv, "--ca-bundle"),
        });
        distributions = planned.distributions;
      }
      const distribution = projectDistribution(projectDir);
      if (distribution && !distributions.includes(distribution)) {
        commandError(`${version} does not contain this project's ${distribution} runtime`, EXIT.usage);
      }
      if (dryRun) {
        return success(
          `Project pin plan for aidlc ${version}; no files were changed.`,
          { projectDir: responseProjectDir, version, pinned: true, dryRun: true },
        );
      }
      commitProjectPin(projectDir, version);
      return success(
        `Pinned this project to aidlc ${version}. Commit .aidlc-version to share the pin.`,
        { projectDir: responseProjectDir, version, pinned: true },
      );
    } finally {
      releaseReservation?.();
    }
  } catch (error) {
    return lifecycleFailureResult(error, argv);
  }
}

async function useCommand(argv: string[]): Promise<CommandResult> {
  const executable = compiledExecutable();
  const manager = executable ? packageManagerForExecutable(executable) : null;
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-version switching is disabled`,
      EXIT.failure,
      manager.remediation,
    );
  }
  const value = argv[1];
  if (!value || value.startsWith("--")) return usage("usage: aidlc use <version>");
  if (argv.includes("--pin")) {
    return usage("use --pin is not supported; run aidlc config --pin <version>");
  }
  if (value === "current") {
    return usage("use current is not supported; run aidlc config --unpin");
  }
  if (argv.includes("--harness")) return usage("unknown argument: --harness");
  const version = requestedVersion(value);
  if (existsSync(versionRoot(version)) && !completeVersion(version)) {
    const reason = inspectInstalledVersion(version).reason ?? "integrity validation failed";
    commandError(`retained version ${version} is incomplete: ${reason}`, EXIT.integrity);
  }
  if (!completeVersion(version)) {
    await installVersion({
      version,
      from: valueAfter(argv, "--from"),
      offline: offline(argv),
      activate: false,
      dryRun: false,
      baseUrl: valueAfter(argv, "--release-base-url"),
      caBundle: valueAfter(argv, "--ca-bundle"),
    });
  }
  activate(version);
  return success(`active AI-DLC version set to ${version}`, { version });
}

function installProfileCommand(argv: string[]): CommandResult {
  const profileValue = valueAfter(argv, "--profile");
  const binValue = valueAfter(argv, "--bin-dir");
  if (!profileValue || !binValue) {
    return usage(
      "install-profile writes the invoking user's shell profile; requires --profile <path> and --bin-dir <path>",
    );
  }
  const profile = resolve(profileValue);
  const bin = resolve(binValue);
  const home = resolve(process.env.HOME || "");
  if (!process.env.HOME) {
    return failure("profile path must be inside the target user's home directory", EXIT.integrity);
  }
  let profileRelative: string;
  try {
    profileRelative = relative(
      realpathSync(home),
      join(realpathSync(dirname(profile)), basename(profile)),
    );
  } catch {
    return failure(
      "profile parent must exist inside the target user's home directory",
      EXIT.integrity,
    );
  }
  if (
    profileRelative === ".." ||
    profileRelative.startsWith(`..${sep}`) ||
    isAbsolute(profileRelative)
  ) {
    return failure("profile path must be inside the target user's home directory", EXIT.integrity);
  }
  let profileMode = 0o600;
  let profileExists = false;
  try {
    const stat = lstatSync(profile);
    profileExists = true;
    profileMode = stat.mode & 0o777;
    if (!stat.isFile()) {
      return failure("profile path is not a regular file", EXIT.integrity);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const begin = "# BEGIN AI-DLC:PATH";
  const end = "# END AI-DLC:PATH";
  const current = profileExists ? readFileSync(profile, "utf-8") : "";
  const lines = current.split(/\r?\n/);
  const beginLines: number[] = [];
  const endLines: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === begin) beginLines.push(index);
    if (line === end) endLines.push(index);
  }
  const beginOccurrences = current.split(begin).length - 1;
  const endOccurrences = current.split(end).length - 1;
  if (
    beginOccurrences !== beginLines.length ||
    endOccurrences !== endLines.length ||
    beginLines.length > 1 ||
    endLines.length > 1 ||
    beginLines.length !== endLines.length ||
    (beginLines.length === 1 && beginLines[0] >= endLines[0])
  ) {
    return failure("profile AI-DLC PATH markers are missing, duplicated, or malformed", EXIT.integrity);
  }
  const escapedBin = bin.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$").replaceAll("`", "\\`");
  const block = `${begin}\nexport PATH="${escapedBin}:$PATH"\n${end}`;
  let next: string;
  if (beginLines.length === 1) {
    const start = current.indexOf(begin);
    const finish = current.indexOf(end, start + begin.length) + end.length;
    next = `${current.slice(0, start)}${block}${current.slice(finish)}`;
  } else {
    const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
    next = `${prefix}${prefix.length > 0 ? "\n" : ""}${block}\n`;
  }
  executePlan({
    schemaVersion: 1,
    root: dirname(profile),
    operations: [writeOperation(
      basename(profile),
      next,
      transactionState(profile),
      profileMode,
    )],
  });
  return success(`updated ${profile} with an owned AI-DLC PATH block`, { profile, bin });
}

function humanLifecycleNarration(
  command: string | undefined,
  argv: readonly string[],
  before: string | null,
  result: CommandResult,
): string | null {
  if (!result.ok) return null;
  if (command === "update" && !argv.includes("--check")) {
    const data = result.data as {
      version?: string;
      pruned?: string[];
      pruneWarning?: string;
    } | undefined;
    const target = data?.version;
    if (!target) return null;
    const pruned = data?.pruned ?? [];
    const pruneLine = pruned.length > 0
      ? `\nPruned unprotected releases: ${pruned.join(", ")}.`
      : data?.pruneWarning
      ? `\nWarning: update succeeded, but old-release cleanup was skipped: ${data.pruneWarning}`
      : "";
    if (argv.includes("--dry-run")) {
      return warnVerdict(
        `Would update aidlc from ${before ?? "not installed"} to ${target}.`,
        process.stdout,
      );
    }
    if (before === target) {
      return `${successText(
        `You're on the latest version of aidlc (${target}).`,
        process.stdout,
      )}${pruneLine}`;
    }
    return [
      `Checking for releases ... ${before ?? "not installed"} -> ${target}`,
      `Downloading aidlc ${target} ... done (verified)`,
      `Staging and switching ... done (${
        before ? `${before} retained` : "no prior version retained"
      })`,
      ...(pruned.length > 0 ? [`Pruned unprotected releases: ${pruned.join(", ")}.`] : []),
      ...(data?.pruneWarning
        ? [`Warning: old-release cleanup was skipped: ${data.pruneWarning}`]
        : []),
      "",
      successText(
        `Updated aidlc from ${before ?? "not installed"} to ${target}.`,
        process.stdout,
      ),
      "Project files were not changed. Run 'aidlc config' between workflows to refresh them.",
    ].join("\n");
  }
  if (command === "use") {
    const target = (result.data as { version?: string } | undefined)?.version ?? argv[1];
    if (!target) return null;
    return successText(
      before === target
        ? `Already using aidlc ${target}.`
        : `Now using aidlc ${target} (was ${
            before ?? "not installed"
          }; retained locally, no project changes).`,
      process.stdout,
    );
  }
  if (command === "uninstall") {
    const data = result.data as {
      purge?: boolean;
      deferred?: boolean;
    } | undefined;
    if (data?.deferred) return null;
    return successText(
      data?.purge
        ? "Removed aidlc, all retained releases, machine settings, update cache, pins, and harness default. Project files were kept."
        : "Removed aidlc and all retained releases. Machine settings, update cache, pins, harness default, and project files were kept.",
      process.stdout,
    );
  }
  return null;
}

export async function main(input: string[]): Promise<void> {
  const argv = input;
  const options = globalOptions(argv);
  const validation = validatePublicLifecycleArgs(argv);
  if (validation) {
    emitResult(usage(validation), options);
    return;
  }
  try {
    const command = argv[0];
    const before = activeVersion();
    const result = command === "versions"
      ? await versionsCommand(argv)
      : command === "update"
      ? await updateCommand(argv)
      : command === "rollback"
      ? rollbackCommand(argv)
      : command === "use"
      ? await useCommand(argv)
      : command === "uninstall"
      ? uninstallCommand(argv)
      : command === "install-profile"
      ? installProfileCommand(argv)
      : command === "install-apply"
      ? success(
          `installed ${(await installVersion({
            version: valueAfter(argv, "--version"),
            from: valueAfter(argv, "--from"),
            offline: true,
            activate: true,
            dryRun: false,
            baseUrl: valueAfter(argv, "--release-base-url"),
            caBundle: valueAfter(argv, "--ca-bundle"),
          })).version}`,
        )
      : usage("unknown lifecycle command");
    const narration = options.mode === "human"
      ? humanLifecycleNarration(command, argv, before, result)
      : null;
    if (narration !== null) {
      process.stdout.write(`${narration}\n`);
      process.exitCode = result.code;
    } else {
      emitResult(result, options);
    }
  } catch (error) {
    emitResult(lifecycleFailureResult(error, argv), options);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aidlc lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  });
}
