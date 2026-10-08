#!/usr/bin/env bun
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
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
  renameSync,
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
  readTerminalLine,
  success,
  usage,
  valueAfter,
} from "./aidlc-command.ts";
import {
  success as successText,
  warnVerdict,
} from "./aidlc-color.ts";
import {
  compareVersions,
  isReleaseChannel,
  PREVIEW_CHANNEL,
  RELEASE_CHANNELS,
  type ReleaseChannel,
  requireVersion,
  VERSION_ID,
  VERSION_ID_PATTERN,
  versionChannel,
} from "./aidlc-channel.ts";
import {
  projectionFiles,
  sha256File,
  walkFiles,
} from "./aidlc-distribution.ts";
import {
  activeVersion,
  activeExecutablePath,
  activeVersionPath,
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
  readActiveExecutable,
  readVersionMarker,
  rollbackVersionPath,
  runtimeIntegrityPath,
  runtimeRoot,
  targetTriple,
  versionRoot,
  versionsRoot,
  windowsPosixCommandPath,
  windowsPosixShim,
  windowsPosixLauncherBodyIsOwned,
} from "./aidlc-install-paths.ts";
import {
  channelPath,
  defaultHarnessPath,
  machineConfigPath,
  readMachineChannel,
  updateCachePath,
  writeMachineChannel,
} from "./aidlc-machine-config.ts";
import {
  acquireRelease,
  digest,
  releaseRuntimeAsset,
  ReleaseUnavailableError,
  resolvePreviewVersion,
} from "./aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  type TransactionPlan,
  writeOperation,
} from "./aidlc-transaction.ts";
import {
  assertSafeUninstallRoot,
  buildUninstallPlan,
} from "./aidlc-uninstall-plan.ts";
import { channelWays, refreshUpdateState, type UpdateState } from "./aidlc-update.ts";
import {
  currentWindowsElevationType,
  describeWindowsUninstallFailure,
  elevatedUninstallWarning,
  recoverWindowsUninstallContinuations,
  scheduleWindowsUninstall as scheduleWindowsUninstallContinuation,
} from "./aidlc-windows-uninstall.ts";
import {
  compiledExecutable,
  discoverProjectHarnesses,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

export class LifecycleCommandError extends Error {
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
      "--channel",
      "--from",
      "--project-dir",
      "--release-api-url",
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
      "--yes",
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
      "--yes",
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
  if (command === "update" && argv.includes("--channel")) {
    const channel = valueAfter(argv, "--channel");
    if (!channel || !isReleaseChannel(channel)) {
      return `--channel must be ${RELEASE_CHANNELS.join(" or ")}`;
    }
    for (const flag of ["--from", "--version"]) {
      if (argv.includes(flag)) return `--channel cannot be combined with ${flag}`;
    }
  }
  return null;
}

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

const RESERVATION_ENTRY = new RegExp(`^(${VERSION_ID_PATTERN})-(\\d+)-[a-f0-9-]+$`);

function reservedVersions(): Set<string> {
  const reserved = new Set<string>();
  const root = reservationRoot();
  if (!existsSync(root)) return reserved;
  for (const entry of readdirSync(root)) {
    const match = RESERVATION_ENTRY.exec(entry);
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

const RESERVATION_RETRY_MS = 25;
// Hooks dispatch on every tool call, so a pinned dispatch waits only for
// ordinary queuing behind other hooks.
const DISPATCH_RESERVATION_WAIT_MS = 30_000;

function machineLockBusy(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("another AI-DLC mutation holds ");
}

function reserveVersion(
  version: string,
  options: { validateLocked?: () => void; waitMs?: number } = {},
): () => void {
  const root = machineTransactionRoot();
  const path = join(
    reservationRoot(),
    `${requireVersion(version)}-${process.pid}-${randomUUID()}`,
  );
  const plan: TransactionPlan = {
    schemaVersion: 1,
    root,
    operations: [writeOperation(
      relative(root, path),
      `${JSON.stringify({ version, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "absent",
      0o600,
    )],
  };
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS);
  for (;;) {
    try {
      executePlan(plan, { validateLocked: options.validateLocked });
      break;
    } catch (error) {
      if (!machineLockBusy(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(RESERVATION_RETRY_MS + Math.floor(Math.random() * RESERVATION_RETRY_MS));
    }
  }
  // Release outside the lock leaves the directory: removing it here could land
  // between another reservation's mkdir and rename. Uninstall removes it.
  return () => {
    rmSync(path, { force: true });
  };
}

// A plain `aidlc update` never installs a release older than the one running:
// the newest release of the channel the machine follows is older, so there is
// nothing to update. Thrown before any asset downloads.
class OlderThanRunningError extends Error {
  constructor(readonly latest: string) {
    super(`the newest release, ${latest}, is older than the one running`);
  }
}

class IncompleteVersionError extends LifecycleCommandError {
  constructor(version: string, reason: string | undefined) {
    super(
      `cannot reserve incomplete retained version ${version}: ${
        reason ?? "integrity validation failed"
      }`,
      EXIT.integrity,
    );
  }
}

// The dispatcher's one integrity check of the release it runs: under the
// machine lock as the reservation lands, so a concurrent uninstall or update
// cannot slip between them. Null means the machine lock stayed busy, so the
// release was checked unlocked and the caller runs unreserved: the reservation
// is bookkeeping, and prune already keeps every registered pin.
export function reserveDispatchedVersion(
  version: string,
  distribution: string | null = null,
): (() => void) | null {
  const raw = process.env.AIDLC_PIN_RESERVATION_TIMEOUT_MS;
  const configured = raw?.trim() ? Number(raw) : NaN;
  const waitMs = Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DISPATCH_RESERVATION_WAIT_MS;
  const check = () => {
    const inspection = inspectPinnedVersion(version, distribution);
    if (!inspection.complete) throw new IncompleteVersionError(version, inspection.reason);
  };
  try {
    return reserveVersion(version, { validateLocked: check, waitMs });
  } catch (error) {
    if (!machineLockBusy(error)) throw error;
  }
  check();
  return null;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// The person typed the command, so at a terminal it says what it removes and
// keeps, then does it. A script or an agent has no terminal and passes --yes.
function announceRemoval(argv: readonly string[], message: string): void {
  if (argv.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    commandError(
      `${message.replace(/\.$/, "")}; non-interactive use requires --yes`,
      EXIT.usage,
    );
  }
  // Printed before anything is removed; stdout stays the JSON result's own.
  (argv.includes("--json") ? process.stderr : process.stdout).write(`${message}\n`);
}

// aidlc.cmd and its helper. The Git Bash launcher beside them has its own check:
// a person's own bin\aidlc must not block uninstall, which keeps that file.
function windowsLauncherOwnedByInstaller(): boolean {
  try {
    const helper = readFileSync(windowsShimPath(), "utf-8");
    return readFileSync(commandPath(), "utf-8") === windowsShim() &&
      [windowsShimHelper(), ...previousWindowsShimHelpers()].includes(helper);
  } catch {
    return false;
  }
}

// The extensionless Git Bash launcher is an additive file: an install written
// by a version that predates it has none, so absence is still installer-owned
// (activateReserved writes it on the next activation). Only a file whose
// contents are not the forwarder we render marks the launcher foreign.
function windowsPosixLauncherOwnedByInstaller(): boolean {
  const path = windowsPosixCommandPath();
  if (path === null || !existsSync(path)) return true;
  try {
    // A symlink or directory named aidlc is NOT ours: check the entry itself
    // (lstat, no follow) before reading, mirroring how the uninstall plan
    // preserves non-regular files. Without this, a symlink whose target
    // happened to match the forwarder body would read as owned and be
    // overwritten/removed.
    if (!lstatSync(path).isFile()) return false;
    return windowsPosixLauncherBodyIsOwned(readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
}

// A bin\aidlc that AI-DLC did not write, such as a hand-made Git Bash
// forwarder. A directory is a name clash, not a launcher to replace; activation
// names it.
function foreignWindowsPosixLauncher(): string | null {
  const path = windowsPosixCommandPath();
  if (path === null || !existsSync(path) || windowsPosixLauncherOwnedByInstaller()) return null;
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? null : path;
}

function foreignWindowsPosixLauncherRefusal(path: string): string {
  return `${path} wasn't made by AI-DLC, so it was left as it is. Move ${path} aside, then run this command again.`;
}

type LauncherReplacement = { backup: string; out: { write(text: string): unknown } };

// The person asked to install or switch versions, not to overwrite their own
// file, so at a terminal this asks once (Enter means yes), --yes answers yes
// for a script or an agent, and otherwise the refusal names the step. It asks
// before any download or lock; activation moves the file.
function windowsPosixLauncherReplacement(argv: readonly string[]): LauncherReplacement | undefined {
  const path = foreignWindowsPosixLauncher();
  if (path === null) return undefined;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let backup = `${path}.bak-${stamp}`;
  for (let n = 2; pathEntryExists(backup); n += 1) backup = `${path}.bak-${stamp}-${n}`;
  const out = argv.includes("--json") || argv.includes("--quiet") ? process.stderr : process.stdout;
  if (argv.includes("--yes")) return { backup, out };
  if (!process.stdin.isTTY && process.env.AIDLC_TEST_CONFIG_TTY !== "1") {
    commandError(foreignWindowsPosixLauncherRefusal(path), EXIT.integrity);
  }
  const answer = readTerminalLine(
    `${path} wasn't made by AI-DLC. Replace it with AI-DLC's launcher? Your file is kept as ${backup}. [Y/n]:`,
    0,
    out,
  );
  if (answer === null || !/^\s*(?:y|yes)?\s*$/i.test(answer)) {
    commandError(foreignWindowsPosixLauncherRefusal(path), EXIT.failure);
  }
  return { backup, out };
}

function unixLauncherOwnedByInstaller(): boolean {
  try {
    return lstatSync(commandPath()).isFile() &&
      [unixShim(), stableOnlyUnixShim()].includes(readFileSync(commandPath(), "utf-8"));
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

type PinRegistry = {
  // Usable registrations keyed by canonical project path.
  pins: Record<string, string>;
  // Every problem found; `versions list` reports them and prune refuses.
  warnings: string[];
  // The whole file is unreadable, so nothing in it can be trusted.
  unreadable: boolean;
  // Canonical projects whose equivalent keys disagree on the version.
  conflicted: Set<string>;
  // Raw entries that were not folded into `pins` (invalid, unresolvable, or
  // conflicting for another project), kept as parsed so a rewrite serializes
  // them unchanged and one project's pin cannot erase another project's record.
  preserved: Record<string, unknown>;
};

function readPinRegistry(reconcileProject?: string): PinRegistry {
  const path = join(installRoot(), "pins.json");
  const empty: PinRegistry = {
    pins: {},
    warnings: [],
    unreadable: false,
    conflicted: new Set(),
    preserved: {},
  };
  if (!existsSync(path)) return empty;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const warning = `${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    return { ...empty, warnings: [warning], unreadable: true };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const warning = `${path} must contain a project-to-version object`;
    return { ...empty, warnings: [warning], unreadable: true };
  }
  const registry: PinRegistry = {
    pins: {},
    warnings: [],
    unreadable: false,
    conflicted: new Set(),
    preserved: {},
  };
  const { pins, warnings, conflicted, preserved } = registry;
  const groups = new Map<string, Array<[project: string, rawVersion: unknown]>>();
  for (const [project, rawVersion] of Object.entries(value as Record<string, unknown>)) {
    if (!isAbsolute(project)) {
      warnings.push(`${path} contains an invalid pin entry for ${project}`);
      preserved[project] = rawVersion;
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
      preserved[project] = rawVersion;
      continue;
    }
    // The project being re-pinned or unpinned replaces every equivalent key
    // it owns, malformed ones included.
    if (canonical === reconcileProject) continue;
    const group = groups.get(canonical) ?? [];
    group.push([project, rawVersion]);
    groups.set(canonical, group);
  }
  for (const [canonical, entries] of groups) {
    const malformed = entries.filter(([, rawVersion]) =>
      typeof rawVersion !== "string" || !VERSION_ID.test(rawVersion)
    );
    if (malformed.length > 0) {
      for (const [project] of malformed) {
        warnings.push(`${path} contains an invalid pin entry for ${project}`);
      }
      // A filesystem-equivalent key group is one ownership record. If any
      // member is unusable, preserve the complete raw group so an unrelated
      // rewrite cannot hide the warning or silently choose another member.
      for (const [project, rawVersion] of entries) preserved[project] = rawVersion;
      continue;
    }
    const versions = new Set(entries.map(([, rawVersion]) => rawVersion as string));
    if (versions.size === 1) {
      pins[canonical] = entries[0][1] as string;
      continue;
    }
    conflicted.add(canonical);
    for (const [project, rawVersion] of entries) preserved[project] = rawVersion;
    warnings.push(
      `${path} contains conflicting equivalent pin entries for ${canonical}`,
    );
  }
  return registry;
}

function canonicalProjectPath(projectDir: string): string {
  return canonicalPolicyPath(projectDir);
}

// A registration protects its retained version while the project still
// declares that pin in `.aidlc-version`. The machine-local pin-target marker is
// a dispatch precondition (regenerated by `config --pin`), not an ownership
// record: losing it to `git clean` or an aliased install spelling must not turn
// a pinned version into prune fodder.
function projectDeclaresPin(projectDir: string, version: string): boolean {
  try {
    const pinPath = join(projectDir, ".aidlc-version");
    return existsSync(pinPath) &&
      statSync(pinPath).isFile() &&
      readFileSync(pinPath, "utf-8").trim() === version;
  } catch {
    return false;
  }
}

function registeredPins(): {
  pins: Record<string, string>;
  warnings: string[];
} {
  const { pins: rawPins, warnings } = readPinRegistry();
  const pins: Record<string, string> = {};
  for (const [project, version] of Object.entries(rawPins)) {
    if (existsSync(project) && !projectDeclaresPin(project, version)) continue;
    pins[project] = version;
  }
  return { pins, warnings };
}

function commitProjectPin(projectDir: string, version: string | null): void {
  const project = canonicalProjectPath(projectDir);
  const pinPath = join(projectDir, ".aidlc-version");
  const targetPath = projectPinTargetPath(projectDir);
  const registryPath = join(installRoot(), "pins.json");
  const registry = readPinRegistry(project);
  if (registry.unreadable) commandError(registry.warnings.join("; "), EXIT.integrity);
  // Other projects' entries ride along unchanged (usable ones canonicalized,
  // unusable ones verbatim); this project's equivalent keys were skipped on
  // read and collapse to the single canonical registration below.
  const pins: Record<string, unknown> = { ...registry.preserved, ...registry.pins };
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
  | {
      kind: "execute";
      executable: string;
      version: string;
      // Set with `reserve`: lets the reservation go, or null when the machine
      // lock stayed busy and the command runs unreserved.
      release?: (() => void) | null;
    };

// An inspection that throws counts as incomplete.
function inspectPinnedVersion(
  version: string,
  distribution: string | null,
): { complete: boolean; reason?: string } {
  try {
    return inspectInstalledVersion(version, distribution);
  } catch (error) {
    return { complete: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function completePinnedVersion(
  version: string,
  distribution: string | null,
): boolean {
  return inspectPinnedVersion(version, distribution).complete;
}

// The dispatcher resolves the project once (explicit flag before `--`, then the
// project environment, then cwd) and passes it here, so the pinned binary is
// always selected for the directory the route policy inspected. The argv
// overload only remains for direct callers and tests. With `reserve`, a release
// to run is checked once, as it is reserved (reserveDispatchedVersion).
export function resolvePinnedDispatch(
  argv: string[],
  projectDir: string = projectDirFrom(argv),
  options: { reserve?: boolean } = {},
): PinnedDispatchResult {
  const pinPath = join(projectDir, ".aidlc-version");
  if (!existsSync(pinPath)) return { kind: "none" };
  const version = readFileSync(pinPath, "utf-8").trim();
  if (!VERSION_ID.test(version)) {
    return {
      kind: "failure",
      code: EXIT.usage,
      message: `${pinPath} must contain one release version id`,
      remediation: "aidlc config --unpin",
    };
  }
  const remediation = `aidlc config --pin ${version}`;
  const registry = readPinRegistry();
  const project = canonicalProjectPath(projectDir);
  // Another project's malformed or conflicting entries are reported by
  // `versions list` and block prune; they never decide this project's dispatch.
  if (registry.unreadable) {
    return {
      kind: "failure",
      code: EXIT.integrity,
      message: `this project's pin registry is invalid: ${registry.warnings.join("; ")}`,
      remediation,
    };
  }
  if (registry.conflicted.has(project)) {
    return {
      kind: "failure",
      code: EXIT.integrity,
      message: `this project's pin registry is invalid: ${
        join(installRoot(), "pins.json")
      } contains conflicting equivalent pin entries for ${project}`,
      remediation,
    };
  }
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
  const incomplete: PinnedDispatchResult = {
    kind: "failure",
    code: EXIT.failure,
    message: `this project requires ${version}, which is not installed completely`,
    remediation,
  };
  const dispatched = process.env.AIDLC_PIN_DISPATCHED === version;
  // The release a dispatcher launched was checked by it just before.
  if (dispatched && version === AIDLC_VERSION) return { kind: "none" };
  const runsHere = dispatched || version === AIDLC_VERSION;
  if (runsHere || !options.reserve) {
    if (!completePinnedVersion(version, distribution)) return incomplete;
    return runsHere ? { kind: "none" } : { kind: "execute", executable: target.target, version };
  }
  try {
    return {
      kind: "execute",
      executable: target.target,
      version,
      release: reserveDispatchedVersion(version, distribution),
    };
  } catch (error) {
    if (error instanceof IncompleteVersionError) return incomplete;
    throw error;
  }
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

// Same-release identity: identical path set and bytes. Modes are deliberately
// not compared - extraction inherits the caller's umask (install.sh uses 077,
// a later `aidlc update` uses the shell's), so modes differ between equally
// valid installs of one release. The installed tree's own modes are enforced
// against its recorded runtime-integrity baseline by completeVersion().
function treesMatch(left: string, right: string): boolean {
  const leftFiles = walkFiles(left).map((path) => path.replaceAll("\\", "/"));
  const rightFiles = walkFiles(right).map((path) => path.replaceAll("\\", "/"));
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  return leftFiles.every((path) => sha256File(join(left, path)) === sha256File(join(right, path)));
}

type RetainedVersion = {
  version: string;
  channel: ReleaseChannel;
  active: boolean;
  rollback: boolean;
  distributions: string[];
  complete: boolean;
  reserved: boolean;
  pinPaths: string[];
  stalePinPaths: string[];
};

// Preview retention is a bounded window on top of the protection every
// release has (active, rollback, in use, pinned): the newest complete previews
// in this window stay so a preview user always has a recent fallback, and
// every older preview outside it is pruned on the next update. Stable releases
// keep the unchanged active, rollback, in-use, and pinned protection.
const RETAINED_PREVIEWS = 2;

function retainedVersions(): {
  versions: RetainedVersion[];
  pinWarnings: string[];
} {
  const { pins, warnings } = registeredPins();
  if (!existsSync(versionsRoot())) return { versions: [], pinWarnings: warnings };
  const active = activeVersion();
  const reservations = reservedVersions();
  const rollback = existsSync(rollbackVersionPath())
    ? readFileSync(rollbackVersionPath(), "utf-8").trim()
    : null;
  const versions = readdirSync(versionsRoot())
    .filter((entry) => VERSION_ID.test(entry))
    .sort(compareVersions)
    .map((version) => ({
      version,
      channel: versionChannel(version),
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

function recentPreviews(versions: readonly RetainedVersion[]): Set<string> {
  return new Set(
    versions
      .filter((item) => item.channel === PREVIEW_CHANNEL && item.complete)
      .sort((left, right) => compareVersions(right.version, left.version))
      .slice(0, RETAINED_PREVIEWS)
      .map((item) => item.version),
  );
}

function protectionReasons(
  item: RetainedVersion,
  recent: ReadonlySet<string>,
): string[] {
  return [
    ...(item.active ? ["active"] : []),
    ...(item.rollback ? ["rollback"] : []),
    ...(item.reserved ? ["in use"] : []),
    ...item.pinPaths.map((path) => `pinned by ${path}`),
    ...item.stalePinPaths.map((path) => `stale pin ${path}`),
    ...(item.channel === PREVIEW_CHANNEL && recent.has(item.version)
      ? [`recent ${PREVIEW_CHANNEL}`]
      : []),
  ];
}

function partitionRetained(versions: readonly RetainedVersion[]): {
  removable: RetainedVersion[];
  protectedVersions: RetainedVersion[];
  protection: string;
} {
  const recent = recentPreviews(versions);
  const removable: RetainedVersion[] = [];
  const protectedVersions: RetainedVersion[] = [];
  const reasons: string[] = [];
  for (const item of versions) {
    const why = protectionReasons(item, recent);
    if (why.length === 0) {
      removable.push(item);
    } else {
      protectedVersions.push(item);
      reasons.push(`${item.version} (${why.join(", ")})`);
    }
  }
  return { removable, protectedVersions, protection: reasons.join("; ") };
}

function assertVersionsRemainPrunable(versions: readonly string[]): void {
  const refreshed = retainedVersions();
  if (refreshed.pinWarnings.length > 0) {
    commandError(
      `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
      EXIT.integrity,
    );
  }
  const stillRemovable = new Set(
    partitionRetained(refreshed.versions).removable.map((item) => item.version),
  );
  const protectedVersions = versions.filter((version) => !stillRemovable.has(version));
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
  const shimHelper = windows ? windowsShimHelperFor(version) : null;
  // The Git Bash launcher guard runs first among the Windows integrity checks,
  // so a foreign or directory bin/aidlc is named as itself.
  const posixCommand = windows ? windowsPosixCommandPath() : null;
  const posixShim = windowsPosixShim();
  if (
    posixCommand !== null &&
    existsSync(posixCommand) &&
    !windowsPosixLauncherOwnedByInstaller()
  ) {
    // Distinguish a directory (a name collision the user must clear by hand)
    // from a foreign file, so the error is actionable rather than a blanket
    // "not owned". statSync tolerates a concurrent delete via throwIfNoEntry.
    const info = statSync(posixCommand, { throwIfNoEntry: false });
    commandError(
      info?.isDirectory()
        ? `${posixCommand} is a directory, not the Git Bash launcher file; ` +
            "remove or rename it, then re-run install"
        : foreignWindowsPosixLauncherRefusal(posixCommand),
      EXIT.integrity,
    );
  }
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
    ![windowsShimHelper(), ...previousWindowsShimHelpers()].includes(
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
          writeOperation(
            relative(root, posixCommand as string),
            posixShim,
            transactionState(posixCommand as string),
            0o700,
          ),
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
          ? !windowsLauncherOwnedByInstaller() || !windowsPosixLauncherOwnedByInstaller()
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

export function activate(
  version: string,
  options: { failAfter?: number; replaceLauncher?: LauncherReplacement } = {},
): void {
  const releaseReservation = reserveVersion(version);
  try {
    // The person's file moves only now, and comes back if activation fails.
    const replace = options.replaceLauncher;
    const moved = replace ? foreignWindowsPosixLauncher() : null;
    if (replace && moved !== null) renameSync(moved, replace.backup);
    try {
      activateReserved(version, { failAfter: options.failAfter });
    } catch (error) {
      if (replace && moved !== null && !pathEntryExists(moved)) renameSync(replace.backup, moved);
      throw error;
    }
    if (replace && moved !== null) {
      replace.out.write(`Replaced ${moved} with AI-DLC's launcher; your file is now ${replace.backup}.\n`);
    }
  } finally {
    releaseReservation();
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// The launcher re-validates the active version marker before trusting the
// pointer, so its grammar must accept every id the lifecycle can activate. The
// stable-only text that shipped before preview ids is still recognised as
// installer-owned so an existing install can be updated in place.
const STABLE_ONLY_VALID_VERSION = [
  "valid_version() {",
  "  version_value=$1",
  "  case \"$version_value\" in *[!0-9.]*|'') return 1 ;; esac",
  "  old_ifs=$IFS",
  "  IFS=.",
  "  set -- $version_value",
  "  IFS=$old_ifs",
  "  [ \"$#\" -eq 3 ] && valid_number \"$1\" && valid_number \"$2\" && valid_number \"$3\"",
  "}",
];

// Shell literal of PREVIEW_CHANNEL: `<x.y.z>-preview.<YYYYMMDD>.<N>`.
const VALID_VERSION = [
  "valid_build() {",
  "  case \"$1\" in ''|*[!0-9]*|0*) return 1 ;; *) return 0 ;; esac",
  "}",
  "valid_version() {",
  "  version_value=$1",
  "  preview_suffix=",
  "  case \"$version_value\" in",
  `    *-${PREVIEW_CHANNEL}.*)`,
  `      preview_suffix=\${version_value#*-${PREVIEW_CHANNEL}.}`,
  `      version_value=\${version_value%%-${PREVIEW_CHANNEL}.*}`,
  "      ;;",
  "  esac",
  "  case \"$version_value\" in *[!0-9.]*|'') return 1 ;; esac",
  "  old_ifs=$IFS",
  "  IFS=.",
  "  set -- $version_value",
  "  IFS=$old_ifs",
  "  [ \"$#\" -eq 3 ] && valid_number \"$1\" && valid_number \"$2\" && valid_number \"$3\" || return 1",
  "  [ -n \"$preview_suffix\" ] || return 0",
  "  case \"$preview_suffix\" in",
  "    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].*) ;;",
  "    *) return 1 ;;",
  "  esac",
  `  valid_build "\${preview_suffix#*.}"`,
  "}",
];

function renderUnixShim(validVersion: readonly string[]): string {
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
    ...validVersion,
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

function unixShim(): string {
  return renderUnixShim(VALID_VERSION);
}

function stableOnlyUnixShim(): string {
  return renderUnixShim(STABLE_ONLY_VALID_VERSION);
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

// The Git Bash forwarder renderer lives in aidlc-install-paths.ts (a shared
// home the uninstall plan can also import without a cycle). Re-exported here so
// existing callers and tests that import it from lifecycle keep resolving.
export { windowsPosixShim };

// The .NET regex source is the shared VERSION_ID_PATTERN verbatim. Every
// refusal prints one "aidlc:" line with the cause and the repair, then exits
// 4. Arguments reach the executable through --% and AIDLC_SHIM_ARGS, quoted
// with the Windows C runtime rules, because Windows PowerShell 5.1 drops empty
// arguments and strips embedded double quotes when it forwards @args itself.
function windowsShimHelper(): string {
  const pointer = activeExecutablePath().replaceAll("'", "''");
  const versionPointer = activeVersionPath().replaceAll("'", "''");
  const root = versionsRoot().replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$pointer = '${pointer}'`,
    `$versionPointer = '${versionPointer}'`,
    `$root = '${root}'`,
    "$repair = 'Rerun the AI-DLC installer (install.ps1) to repair the aidlc command.'",
    "function Stop-Launcher([string]$reason) {",
    "  $line = \"aidlc: $reason\"",
    "  try { [Console]::Error.WriteLine($line) } catch { Write-Error -Message $line -ErrorAction Continue }",
    "  exit 4",
    "}",
    "function Format-NativeArgument([string]$value) {",
    "  $quote = $value.Length -eq 0",
    "  $out = ''",
    "  $slashes = 0",
    "  foreach ($c in $value.ToCharArray()) {",
    "    if ([char]::IsWhiteSpace($c)) { $quote = $true }",
    "    if ($c -eq [char]'\\') { $slashes++; continue }",
    "    if ($c -eq [char]'\"') { $out += ('\\' * ($slashes * 2 + 1)) + '\"' } else { $out += ('\\' * $slashes) + $c }",
    "    $slashes = 0",
    "  }",
    "  if ($quote) { return '\"' + $out + ('\\' * ($slashes * 2)) + '\"' }",
    "  return $out + ('\\' * $slashes)",
    "}",
    "$mode = [string]$ExecutionContext.SessionState.LanguageMode",
    "if ($mode -ne 'FullLanguage') {",
    "  Stop-Launcher \"PowerShell runs the launcher $PSCommandPath in $mode mode, so it cannot start aidlc. An application control policy (AppLocker or WDAC) sets that mode; ask your administrator to allow that script, or run aidlc.exe from the active version folder under $root directly.\"",
    "}",
    "try {",
    "  $versions = [IO.Path]::GetFullPath($root)",
    "  if (-not [IO.File]::Exists($versionPointer)) { Stop-Launcher \"active version marker $versionPointer is missing. $repair\" }",
    "  $versionRaw = [IO.File]::ReadAllText($versionPointer)",
    `  if ($versionRaw -notmatch '^${VERSION_ID_PATTERN}\\r?\\n?$') { Stop-Launcher "active version marker $versionPointer is malformed. $repair" }`,
    "  $activeVersion = $versionRaw.TrimEnd(\"`r\", \"`n\")",
    "  if (-not [IO.File]::Exists($pointer)) { Stop-Launcher \"active command target $pointer is missing. $repair\" }",
    "  $raw = [IO.File]::ReadAllText($pointer)",
    "  if ($raw -notmatch '^[^\\r\\n]+\\r?\\n?$') { Stop-Launcher \"active command target $pointer is malformed. $repair\" }",
    "  $executable = [IO.Path]::GetFullPath($raw.TrimEnd(\"`r\", \"`n\"))",
    "  $expected = [IO.Path]::Combine($versions, $activeVersion, 'aidlc.exe')",
    "  if (-not $executable.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { Stop-Launcher \"active command target $executable does not match active version $activeVersion ($expected). $repair\" }",
    "  if (-not [IO.File]::Exists($executable)) { Stop-Launcher \"active executable $executable is missing. $repair\" }",
    "  $env:AIDLC_SHIM_PID = [string]$PID",
    "  if ($args.Count -eq 0) {",
    "    & $executable",
    "    exit $LASTEXITCODE",
    "  }",
    "  $env:AIDLC_SHIM_ARGS = @(foreach ($argument in $args) { Format-NativeArgument $argument }) -join ' '",
    "  & $executable --% %AIDLC_SHIM_ARGS%",
    "  exit $LASTEXITCODE",
    "} catch {",
    "  Stop-Launcher \"the launcher failed: $($_.Exception.Message -replace '\\s+', ' ') $repair\"",
    "}",
    "",
  ].join("\r\n");
}

// A release from before FIRST_RELEASE_WITH_CURRENT_HELPER (2.10.0 among them)
// accepts only the helpers it wrote itself, so while it is the active version
// it keeps its own helper; with the current one it could never switch to
// another version again. 2.8.0 and 2.8.1 wrote the stable-only helper; 2.8.2
// on wrote the shared-marker one.
const FIRST_RELEASE_WITH_CURRENT_HELPER = "2.10.1-preview.20261003.1";
const FIRST_RELEASE_WITH_SHARED_MARKER_HELPER = "2.8.2";
const STABLE_ONLY_HELPER_PATTERN = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";

function predatesCurrentHelper(version: string): boolean {
  // This binary's own version always has the current helper: only a release
  // built before the cutoff ever wrote an older one.
  if (version === AIDLC_VERSION) return false;
  try {
    return compareVersions(version, FIRST_RELEASE_WITH_CURRENT_HELPER) < 0;
  } catch {
    return false;
  }
}

function windowsShimHelperFor(version: string): string {
  if (!predatesCurrentHelper(version)) return windowsShimHelper();
  try {
    if (compareVersions(version, FIRST_RELEASE_WITH_SHARED_MARKER_HELPER) < 0) {
      return renderSilentWindowsShimHelper(STABLE_ONLY_HELPER_PATTERN);
    }
  } catch {
    // An unparsable version cannot be older than 2.8.2.
  }
  return renderSilentWindowsShimHelper(VERSION_ID_PATTERN);
}

// The helper every installer wrote before refusals carried a reason.
function renderSilentWindowsShimHelper(versionPattern: string): string {
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
    `  if ($versionRaw -notmatch '^${versionPattern}\\r?\\n?$') { exit 4 }`,
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

// Helper texts written by earlier installers, oldest last: the silent helper
// over the shared marker grammar, the same helper over the stable-only
// grammar, then the pointer-prefix check that predates the marker.
export function previousWindowsShimHelpers(): string[] {
  const pointer = activeExecutablePath().replaceAll("'", "''");
  const root = versionsRoot().replaceAll("'", "''");
  return [
    renderSilentWindowsShimHelper(VERSION_ID_PATTERN),
    renderSilentWindowsShimHelper(STABLE_ONLY_HELPER_PATTERN),
    [
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
    ].join("\r\n"),
  ];
}

// The running binary and the active executable can name one file in different
// spellings: the pointer keeps the install root's 8.3 short name (RUNNER~1, for
// example; Bun's realpath does not expand it), while the process path is the
// long one. File identity settles it.
function runningActiveExecutable(active: string): boolean {
  if (canonicalPolicyPath(process.execPath).toLowerCase() === active.toLowerCase()) return true;
  try {
    const running = statSync(process.execPath, { bigint: true });
    const target = statSync(active, { bigint: true });
    return running.isFile() && running.ino !== 0n &&
      running.ino === target.ino && running.dev === target.dev;
  } catch {
    return false;
  }
}

// What doctor says about a previous helper the installer wrote. "replace":
// this binary replaces it on its next command. "blocked": it cannot, and
// why. Both fixes activate the verified active version again, which
// rewrites both launcher files and keeps the version and channel; a held
// machine lock is not a reason, the next command retries. "install": the
// active version marker is damaged or disagrees with the command target,
// which no other doctor row reports; the person picks the version. Null: a
// missing or invalid command target, or an incomplete version, which the
// Command pointer and Installed runtime rows report with their own repair.
export type PreviousShimHelperState =
  | { kind: "replace" | "blocked" | "install"; reason: string; fix: string }
  | null;

export function previousWindowsShimHelperState(): PreviousShimHelperState {
  const reinstall = "rerun the same verified AI-DLC installer (install.ps1)";
  let active: string | null;
  try {
    active = readActiveExecutable();
  } catch {
    return null;
  }
  if (!active) return null;
  const target = basename(dirname(active));
  // With aidlc.cmd moved aside, or stopped by the old helper, an aidlc.exe
  // runs `use` by full path.
  const reactivate = `run \`& '${active.replaceAll("'", "''")}' use ${target}\``;
  let version: string | null = null;
  try {
    version = readVersionMarker(activeVersionPath());
  } catch {
    // Reported below as a damaged marker.
  }
  // The new helper refuses what the oldest one accepted without a marker.
  if (version !== target) {
    return {
      kind: "install",
      reason: version
        ? `the active version marker ${activeVersionPath()} names ${version} but the command target names ${target}`
        : `the active version marker ${activeVersionPath()} is missing or damaged`,
      fix: `if you use ${target}, ${reactivate}; for another retained version, run that version's aidlc.exe under ${versionsRoot()} with \`use <version>\`; or ${reinstall}`,
    };
  }
  try {
    if (!completeVersion(target)) return null;
    if (!previousWindowsShimHelpers().includes(readFileSync(windowsShimPath(), "utf-8"))) {
      // The installer owns aidlc.cmd only beside its own helper, so both go.
      return {
        kind: "blocked",
        reason: `${windowsShimPath()} was changed after it was installed`,
        fix: `move ${commandPath()} and ${windowsShimPath()} aside, then ${reactivate}`,
      };
    }
    if (readFileSync(commandPath(), "utf-8") !== windowsShim()) {
      return {
        kind: "blocked",
        reason: `${commandPath()} was changed after it was installed`,
        fix: `move ${commandPath()} aside, then ${reactivate}`,
      };
    }
  } catch {
    return null;
  }
  // That release's own helper is the right one for it.
  if (predatesCurrentHelper(target)) return null;
  if (!runningActiveExecutable(active)) {
    return {
      kind: "blocked",
      reason: `this aidlc.exe is not the active one, ${active}`,
      fix: "run any command through `aidlc`, for example `aidlc version`",
    };
  }
  return {
    kind: "replace",
    reason: "the next aidlc command replaces it",
    fix: `run \`aidlc version\`; if this row is still here, run \`aidlc use ${target}\`, which rewrites the launcher for the version you have and says why if it cannot`,
  };
}

// `aidlc update` runs in the binary it replaces, which writes its own helper,
// so the active binary replaces a previous helper the installer wrote. The
// update's version probe runs this binary while the update holds the machine
// lock, and a helper written outside that lock would stop a rollback of that
// update part way. So the lock is taken without waiting, and while it is held
// the next command replaces the helper instead.
export function replacePreviousWindowsShimHelper(): void {
  try {
    const expected = transactionState(windowsShimPath());
    const repair = olderReleaseHelperRepair();
    const wanted = (): string | null => repair ??
      (previousWindowsShimHelperState()?.kind === "replace" ? windowsShimHelper() : null);
    const helper = wanted();
    if (helper === null) return;
    const root = machineTransactionRoot();
    executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation(relative(root, windowsShimPath()), helper, expected, 0o700),
        ...(repair === null ? gitBashLauncherCatchUp(root) : []),
      ],
    }, {
      // A switch that finished just before the lock was taken can leave the
      // same helper bytes beside another active release: choose again under
      // the lock, and leave the helper if the answer changed.
      validateLocked: () => {
        if (olderReleaseHelperRepair() !== repair || wanted() !== helper) {
          throw new Error("the active release changed before the launcher helper was replaced");
        }
      },
    });
  } catch {
    // The previous helper still starts aidlc; a later command retries.
  }
}

// An older release that updated this machine wrote no Git Bash launcher, so
// hooks run through Git Bash could not find `aidlc`. The first command of this
// release writes it with the helper, when it is missing or one an earlier
// release wrote; a file of anyone else's stays, and doctor names it.
function gitBashLauncherCatchUp(root: string): ReturnType<typeof writeOperation>[] {
  const path = windowsPosixCommandPath();
  if (path === null || !windowsPosixLauncherOwnedByInstaller()) return [];
  const body = windowsPosixShim();
  if (existsSync(path) && readFileSync(path, "utf-8") === body) return [];
  return [writeOperation(relative(root, path), body, transactionState(path), 0o700)];
}

// While a release from before the current helper is active, it needs the
// helper it wrote itself. An installer-owned helper of another era (2.8.2
// switching to 2.8.1 left its own) is put back to that one by any newer binary
// that runs, a pinned project's for example; anything else is left alone.
function olderReleaseHelperRepair(): string | null {
  try {
    const active = readActiveExecutable();
    if (!active) return null;
    const target = basename(dirname(active));
    if (!predatesCurrentHelper(target) || readVersionMarker(activeVersionPath()) !== target) return null;
    if (!completeVersion(target) || readFileSync(commandPath(), "utf-8") !== windowsShim()) return null;
    const installed = readFileSync(windowsShimPath(), "utf-8");
    const wanted = windowsShimHelperFor(target);
    if (installed === wanted) return null;
    return [windowsShimHelper(), ...previousWindowsShimHelpers()].includes(installed) ? wanted : null;
  } catch {
    return null;
  }
}

async function installVersion(options: {
  version?: string;
  from?: string;
  offline?: boolean;
  activate: boolean;
  dryRun: boolean;
  baseUrl?: string;
  caBundle?: string;
  channel?: ReleaseChannel;
  apiUrl?: string;
  replaceLauncher?: LauncherReplacement;
  notOlderThan?: string;
}): Promise<{ version: string; distributions: string[] }> {
  // An explicit version or local directory bypasses discovery. Otherwise the
  // stable channel is the `latest/download` redirect and the preview channel is
  // the newest published preview, installed through the explicit-version path.
  const wantedVersion = options.version
    ? requestedVersion(options.version)
    : !options.from && options.channel === PREVIEW_CHANNEL
    ? await resolvePreviewVersion({
        baseUrl: options.baseUrl,
        apiUrl: options.apiUrl,
        caBundle: options.caBundle,
      })
    : undefined;
  const target = targetTriple();
  const release = await acquireRelease({
    version: wantedVersion,
    from: options.from,
    names: (manifest) => {
      if (options.notOlderThan && compareVersions(manifest.version, options.notOlderThan) < 0) {
        throw new OlderThanRunningError(manifest.version);
      }
      return [binaryAsset(target), releaseRuntimeAsset(manifest.version)];
    },
    offline: options.offline,
    baseUrl: options.baseUrl,
    caBundle: options.caBundle,
  });
  const version = release.manifest.version;
  const runtimeAsset = releaseRuntimeAsset(version);
  const required = [binaryAsset(target), runtimeAsset];
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
    extractTarGz(join(release.directory, runtimeAsset), candidate, {
      reservedTopLevelNames: [
        "aidlc", "aidlc.exe", "runtime-integrity.json", "installed-files.json", "version.json",
      ],
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
    const installedFilesPath = join(candidate, "installed-files.json");
    writeFileSync(
      installedFilesPath,
      `${JSON.stringify(createRuntimeIntegrity(version, candidate), null, 2)}\n`,
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
        installedFiles: {
          schemaVersion: 1,
          baseline: basename(installedFilesPath),
          sha256: sha256File(installedFilesPath),
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
      if (options.activate) activate(version, { replaceLauncher: options.replaceLauncher });
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
            `${item.version}${item.active ? " active" : ""}${item.rollback ? " rollback" : ""} [${item.distributions.join(",")}]${item.pinPaths.length > 0 ? ` pinned by ${item.pinPaths.length} project(s)` : ""}${item.stalePinPaths.length > 0 ? ` ${item.stalePinPaths.length} stale pin(s)` : ""}${item.complete ? "" : " incomplete"}`
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
    const { removable, protectedVersions, protection } = partitionRetained(versions);
    if (removable.length === 0) {
      return success(
        protection
          ? `no versions eligible for pruning; protected: ${protection}`
          : "no versions eligible for pruning",
        { removed: [], protected: protectedVersions },
      );
    }
    announceRemoval(
      argv,
      `Pruning retained versions ${removable.map((item) => item.version).join(", ")}.`,
    );
    const refreshed = retainedVersions();
    if (refreshed.pinWarnings.length > 0) {
      commandError(
        `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
        EXIT.failure,
      );
    }
    const stillRemovable = new Set(
      partitionRetained(refreshed.versions).removable.map((item) => item.version),
    );
    const newlyProtected = removable.filter((item) => !stillRemovable.has(item.version));
    if (newlyProtected.length > 0) {
      commandError(
        `prune cancelled because version protection changed: ${
          newlyProtected.map((item) => item.version).join(", ")
        }`,
        EXIT.failure,
      );
    }
    removeUnprotectedVersionFiles(removable.map((item) => item.version));
    return success(
      `pruned ${removable.map((item) => item.version).join(", ")}${
        protection ? `; protected: ${protection}` : ""
      }`,
      { removed: removable.map((item) => item.version), protected: protectedVersions },
    );
  }
  if (verb !== "install") return usage("usage: aidlc system versions <list|install|prune>");
  const version = argv[2];
  if (!version || version.startsWith("--")) return usage("versions install requires a release version");
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
  const { removable } = partitionRetained(versions);
  if (removable.length === 0) return [];
  const selected = removable.map((item) => item.version);
  removeUnprotectedVersionFiles(selected);
  return selected;
}

function removeUnprotectedVersionFiles(selected: readonly string[]): void {
  const plan = buildUninstallPlan(false);
  const roots = selected.map((version) => resolve(versionRoot(version)));
  const selectedPath = (path: string): boolean => roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  });
  const unowned = plan.preserved.filter(selectedPath);
  if (unowned.length > 0) {
    commandError(
      `refusing to prune versions with unowned or changed paths: ${untrustedPathList(unowned).join(", ")}`,
      EXIT.integrity,
    );
  }
  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: plan.files.filter(({ path }) => selectedPath(path)).map(({ path, expected }) => ({
      kind: "remove" as const,
      path: relative(root, path),
      expected,
    })),
  }, {
    validateLocked: () => assertVersionsRemainPrunable(selected),
  });
  for (const path of plan.directories.filter(selectedPath)) removeEmptyInstallerDirectory(path);
}

function removeEmptyInstallerDirectory(path: string): void {
  try {
    if (
      existsSync(path) &&
      canonicalPolicyPath(path) === resolve(path) &&
      lstatSync(path).isDirectory() &&
      readdirSync(path).length === 0
    ) {
      rmdirSync(path);
    }
  } catch {
    // Non-empty or concurrently reused directories are preserved.
  }
}

type UninstallPlan = ReturnType<typeof buildUninstallPlan>;

// Unowned paths are named by whoever wrote them, and an agent may read this
// output. Show each JSON-escaped and bounded, as doctor does for repository
// names, so a name carrying newlines or instruction-shaped text stays data.
const LISTED_UNOWNED_PATHS = 20;
const UNOWNED_PATH_CHARS = 240;

export function untrustedPathList(paths: readonly string[]): string[] {
  const shown = paths.slice(0, LISTED_UNOWNED_PATHS).map((path) =>
    JSON.stringify(path.length > UNOWNED_PATH_CHARS ? `${path.slice(0, UNOWNED_PATH_CHARS)}...` : path)
  );
  const more = paths.length - shown.length;
  return more > 0 ? [...shown, `(and ${more} more)`] : shown;
}

export function preservedUninstallPaths(paths: readonly string[]): string {
  return paths.length > 0
    ? `\nLeft ${paths.length} path(s) that AI-DLC did not install, or that changed after install, quoted as found:\n${
      untrustedPathList(paths).map((path) => `  ${path}`).join("\n")
    }`
    : "";
}

function uninstallResultData(purge: boolean, plan: UninstallPlan) {
  return {
    purge,
    preserved: purge ? [] : ["config", "update-cache", "pins", "default-harness"],
    preservedUnowned: plan.preserved,
    preservedUnownedCount: plan.preserved.length,
  };
}

function uninstallCommand(argv: string[]): CommandResult {
  try {
    assertSafeUninstallRoot();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), EXIT.integrity);
  }
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
  // The cleanup worker inherits this window's token. A UAC-elevated window is
  // warned before anything is removed; the person asked, so it proceeds.
  const elevation = process.platform === "win32" ? currentWindowsElevationType() : 3;
  const warnings = elevatedUninstallWarning(elevation);
  const warned = (text: string): string => warnings ? `${warnings}\n${text}` : text;
  if (process.platform === "win32") {
    // Uninstall is the explicit retry: it resumes a continuation that already
    // removed files, and re-plans one that failed before removing any.
    const recovery = recoverWindowsUninstallContinuations(purge, { retryFailed: true });
    if (recovery.resumed > 0) {
      return success(
        warned(`resumed ${recovery.resumed} pending Windows uninstall continuation(s)${
          recovery.retriedFailures.length > 0
            ? ` (last attempt ${recovery.retriedFailures.map(describeWindowsUninstallFailure).join("; ")})`
            : ""
        }`),
        { purge, deferred: true, recovered: recovery.resumed, ...(warnings ? { warnings: [warnings] } : {}) },
      );
    }
    if (recovery.running > 0) {
      return failure(
        "a Windows uninstall cleanup is still running",
        EXIT.failure,
        "wait for it to finish, then run doctor",
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
  const plan = buildUninstallPlan(purge);
  const settings = purge
    ? "Machine settings, update cache, pins, harness default, and release channel will be removed."
    : "Machine settings, update cache, pins, harness default, and release channel will be kept.";
  // Anything left in place is listed once, with the result.
  announceRemoval(
    argv,
    warned(`Uninstalling AI-DLC (${versions.length} retained version(s)). Project trees will not be changed. ${settings}`),
  );
  if (process.platform === "win32") {
    return scheduleWindowsUninstall(purge, plan, warnings);
  }
  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: plan.files.map(({ path, expected }) => ({
      kind: "remove" as const,
      path: relative(root, path),
      expected,
    })),
  });
  for (const path of plan.directories) removeEmptyInstallerDirectory(path);
  return success(
    `uninstalled AI-DLC; ${
      purge
        ? "removed owned machine configuration and cache files"
        : "preserved machine configuration and cache"
    }${preservedUninstallPaths(plan.preserved)}`,
    uninstallResultData(purge, plan),
  );
}

function scheduleWindowsUninstall(purge: boolean, plan: UninstallPlan, warning: string | null): CommandResult {
  const preserved = [
    machineConfigPath(),
    updateCachePath(),
    join(installRoot(), "pins.json"),
    defaultHarnessPath(),
    channelPath(),
  ];
  scheduleWindowsUninstallContinuation(purge, preserved, plan);
  return success(
    `${warning ? `${warning}\n` : ""}uninstall scheduled; Windows cleanup will finish after this command exits${
      preservedUninstallPaths(plan.preserved)
    }`,
    { ...uninstallResultData(purge, plan), deferred: true, ...(warning ? { warnings: [warning] } : {}) },
  );
}

// The channel an update follows: the one-shot `--channel` override, else the
// machine marker (stable when absent). An explicit `--version` or `--from`
// selects an exact release regardless of channel.
function requestedChannel(argv: readonly string[]): ReleaseChannel {
  const explicit = valueAfter(argv, "--channel");
  if (explicit) {
    if (!isReleaseChannel(explicit)) {
      commandError(`--channel must be ${RELEASE_CHANNELS.join(" or ")}`, EXIT.usage);
    }
    return explicit;
  }
  try {
    return readMachineChannel();
  } catch (error) {
    return commandError(
      error instanceof Error ? error.message : String(error),
      EXIT.integrity,
    );
  }
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
  const channel = requestedChannel(argv);
  const apiUrl = valueAfter(argv, "--release-api-url");
  if (argv.includes("--check")) {
    let state: UpdateState;
    try {
      state = await refreshUpdateState(DEFAULT_SUBPROCESS_TIMEOUT_MS, {
        offline: offline(argv),
        baseUrl: valueAfter(argv, "--release-base-url"),
        caBundle: valueAfter(argv, "--ca-bundle"),
        channel,
        apiUrl,
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
  // The person names a version, a release folder or a channel to go to that
  // release, older or not; a plain update only ever moves forward.
  const plain = !valueAfter(argv, "--version") && !valueAfter(argv, "--from") && !valueAfter(argv, "--channel");
  let result: Awaited<ReturnType<typeof installVersion>>;
  try {
    result = await installVersion({
      version: valueAfter(argv, "--version"),
      from: valueAfter(argv, "--from"),
      offline: offline(argv),
      activate: true,
      dryRun,
      baseUrl: valueAfter(argv, "--release-base-url"),
      caBundle: valueAfter(argv, "--ca-bundle"),
      channel,
      apiUrl,
      replaceLauncher: dryRun ? undefined : windowsPosixLauncherReplacement(argv),
      ...(plain && current ? { notOlderThan: current } : {}),
    });
  } catch (error) {
    if (!(error instanceof OlderThanRunningError) || !current) throw error;
    return success(`${current} is newer than the latest ${channel} release ${error.latest}; nothing to update`, {
      version: current,
      channel,
      newerThan: { channel, version: error.latest },
    });
  }
  // Moving between channels is a switch, never a downgrade error: the newest
  // stable sorts below a preview built after it, and asking for that channel
  // by name is the way back.
  const channelSwitch = current && versionChannel(current) !== versionChannel(result.version)
    ? { from: versionChannel(current), to: versionChannel(result.version) }
    : undefined;
  // Only `config --channel` changes the channel the machine follows; `--channel`
  // here lasts this run, and `--version` and `--from` pick a release of either
  // channel. So a move onto the other channel is the machine's switch only
  // when the machine already follows it.
  let follows: ReleaseChannel | undefined;
  let followsUnknown = false;
  try {
    follows = channelSwitch ? readMachineChannel() : undefined;
  } catch {
    // The update is done; an unreadable marker is doctor's to report, and the
    // update says nothing about which channel the machine follows.
    followsUnknown = true;
  }
  const switched = channelSwitch
    ? ` (switched channel ${channelSwitch.from} -> ${channelSwitch.to})`
    : "";
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
      ? `update plan: ${current ?? "none"} -> ${result.version} [${result.distributions.join(",")}]${switched}`
      : `updated ${current ?? "new install"} -> ${result.version}${switched}${
        pruned.length > 0 ? `; pruned ${pruned.join(", ")}` : ""
      }`,
    {
      ...result,
      channel,
      ...(channelSwitch ? { channelSwitch } : {}),
      ...(follows !== undefined && follows !== channelSwitch?.to ? { follows } : {}),
      ...(followsUnknown ? { followsUnknown } : {}),
      pruned,
      ...(pruneWarning ? { pruneWarning } : {}),
    },
  );
}

// `aidlc config --channel [stable|preview]`: with a value, persist the machine
// release channel; without one, report the channel in force.
export function configureChannel(argv: readonly string[]): CommandResult {
  const requested = valueAfter(argv, "--channel");
  try {
    if (!requested || requested.startsWith("--")) {
      const channel = readMachineChannel();
      return success(`release channel: ${channel}`, {
        channel,
        source: existsSync(channelPath()) ? "machine" : "default",
      });
    }
    if (!isReleaseChannel(requested)) {
      return usage(`--channel must be ${RELEASE_CHANNELS.join(" or ")}`);
    }
    const channel = writeMachineChannel(requested);
    // A plain update never installs an older release, so from a release of
    // the other channel it waits for a newer one; asked by name it goes now.
    // The channel is saved by now, so a damaged version pointer (doctor
    // reports it) only leaves out that hint.
    let running: string | null = null;
    try {
      running = activeVersion();
    } catch {
      running = null;
    }
    const next = running && versionChannel(running) !== channel
      ? `aidlc update moves to a ${channel} release once one is newer than ${running}; ` +
        `to go to the newest ${channel} release now, run aidlc update --channel ${channel}`
      : "run aidlc update to install its newest release";
    return success(`release channel set to ${channel}; ${next}`, { channel, source: "machine" });
  } catch (error) {
    return lifecycleFailureResult(error, argv);
  }
}

// The version the person typed, as `rollback <version>` or `--version
// <version>`; null when they typed none, so the recorded one is used.
function typedRollbackVersion(argv: readonly string[]): string | null {
  const typed = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version" || arg === "--project-dir") {
      const value = argv[index + 1];
      if (arg === "--version" && value && !value.startsWith("--")) typed.add(value);
      index += 1;
    } else if (!arg.startsWith("--")) {
      typed.add(arg);
    }
  }
  if (typed.size > 1) {
    commandError(`rollback takes one version; you typed ${[...typed].join(" and ")}`, EXIT.usage);
  }
  return [...typed][0] ?? null;
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
  const typed = typedRollbackVersion(argv);
  const target = typed ||
    (existsSync(rollbackVersionPath()) ? readFileSync(rollbackVersionPath(), "utf-8").trim() : "");
  if (!target) {
    commandError("no prior version is recorded; run aidlc use <version>", EXIT.failure);
  }
  if (typed) {
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
    throw new Error(
      `rollback target ${target} lacks harnesses: ${missing.join(", ")}; ` +
        "to roll back anyway, without them, run it again with --allow-harness-loss",
    );
  }
  activate(target, { replaceLauncher: windowsPosixLauncherReplacement(argv) });
  return success(
    !typed && active && active !== target
      ? `rolled back to ${target}, the version you used before ${active}`
      : `rolled back to ${target}`,
    { version: target },
  );
}

// Whether the version store already holds this release for this harness, so
// registering a pin to it needs no download.
export function pinnedReleaseInstalled(version: string, distribution: string): boolean {
  return completePinnedVersion(version, distribution);
}

// The install half of `config --pin <version>` for a project that already names
// that release: install it when this machine lacks it. Registering the pin is
// separate (registerProjectPin), so a config command publishes the new routing
// only after its own refresh has succeeded. Failures throw, carrying the exit
// code `config --pin` would use.
export async function installPinnedRelease(options: {
  projectDir: string;
  version: string;
  distribution: string;
  baseUrl?: string;
  caBundle?: string;
}): Promise<void> {
  const version = requestedVersion(options.version);
  const releaseReservation = reserveVersion(version);
  try {
    if (existsSync(versionRoot(version)) && !completeVersion(version)) {
      const reason = inspectInstalledVersion(version).reason ?? "integrity validation failed";
      commandError(`retained version ${version} is incomplete: ${reason}`, EXIT.integrity);
    }
    const distributions = completeVersion(version)
      ? installedDistributions(version)
      : (await installVersion({
          version,
          activate: false,
          dryRun: false,
          baseUrl: options.baseUrl,
          caBundle: options.caBundle,
        })).distributions;
    if (!distributions.includes(options.distribution)) {
      commandError(`${version} does not contain the ${options.distribution} runtime`, EXIT.usage);
    }
  } finally {
    releaseReservation?.();
  }
}

// The register half of `config --pin <version>`: route this project to its
// installed pinned release.
export function registerProjectPin(projectDir: string, version: string): void {
  commitProjectPin(projectDir, requestedVersion(version));
}

// Keeps a retained release from being pruned while a config command installs,
// refreshes to, and registers it. Call the returned function to let it go.
export function holdPinnedRelease(version: string): () => void {
  return reserveVersion(requestedVersion(version));
}

export interface ProjectPinOptions {
  /** Workflows still running in the project, as `space/intent` names. */
  activeWorkflows?: (projectDir: string) => string[];
  /** The `config` commands that refresh the project, as the person types them (one per harness). */
  refreshCommands?: (projectDir: string) => string[];
}

// A pin changes which engine serves the project at once, while the project's
// own files stay at the version its harness tree was last refreshed to until
// the next `aidlc config`. With work open the pin is done and says to finish
// the update. A tree from before stamps records no version (null), so it never
// counts as a match.
function pinSplitsRunningWorkflow(
  projectDir: string,
  target: string,
  options: ProjectPinOptions,
): boolean {
  if (!options.activeWorkflows) return false;
  const hooks = discoverProjectHarnesses(projectDir).map((harness) => harness.frameworkVersion ?? null);
  if (hooks.every((version) => version === target)) return false;
  return options.activeWorkflows(projectDir).length > 0;
}

function finishUpdate(projectDir: string, options: ProjectPinOptions): string {
  const commands = (options.refreshCommands?.(projectDir) ?? ["aidlc config"]).map((command) => `\`${command}\``);
  const listed = commands.length <= 1
    ? commands.join("")
    : `${commands.slice(0, -1).join(", ")} and ${commands[commands.length - 1]}`;
  return ` Run ${listed} to finish updating this project.`;
}

export async function configureProjectPin(
  argv: string[],
  options: ProjectPinOptions = {},
): Promise<CommandResult> {
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
      // Unpinning makes the project follow the machine's active version.
      const followed = activeVersion();
      const finish = followed !== null && pinSplitsRunningWorkflow(projectDir, followed, options)
        ? finishUpdate(projectDir, options)
        : "";
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
        `Removed this project's AI-DLC version pin; it now follows the active machine version.${finish}`,
        { projectDir: responseProjectDir, version: activeVersion(), pinned: false },
      );
    }
    const requested = valueAfter(argv, "--pin");
    if (!requested) return usage("--pin requires a release version");
    const version = requestedVersion(requested);
    const finish = pinSplitsRunningWorkflow(projectDir, version, options) ? finishUpdate(projectDir, options) : "";
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
        `Pinned this project to aidlc ${version}. Commit .aidlc-version to share the pin.${finish}`,
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
  const replaceLauncher = windowsPosixLauncherReplacement(argv);
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
  activate(version, { replaceLauncher });
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

export function humanLifecycleNarration(
  command: string | undefined,
  argv: readonly string[],
  before: string | null,
  result: CommandResult,
): string | null {
  if (!result.ok) return null;
  if (command === "update" && !argv.includes("--check")) {
    const data = result.data as {
      version?: string;
      channel?: ReleaseChannel;
      channelSwitch?: { from: ReleaseChannel; to: ReleaseChannel };
      follows?: ReleaseChannel;
      followsUnknown?: boolean;
      newerThan?: { channel: ReleaseChannel; version: string };
      pruned?: string[];
      pruneWarning?: string;
    } | undefined;
    const target = data?.version;
    if (!target) return null;
    if (data?.newerThan) {
      return successText(
        `You're on ${target}, newer than the latest ${data.newerThan.channel} ${data.newerThan.version}, so ` +
          `there's nothing to update. ${channelWays(data.newerThan.channel, versionChannel(target), data.newerThan.version)}`,
        process.stdout,
      );
    }
    const channelWord = data?.channel && data.channel !== "stable" ? `${data.channel} ` : "";
    const pruned = data?.pruned ?? [];
    const pruneLine = pruned.length > 0
      ? `\nPruned unprotected releases: ${pruned.join(", ")}.`
      : data?.pruneWarning
      ? `\nWarning: update succeeded, but old-release cleanup was skipped: ${data.pruneWarning}`
      : "";
    const switchLine = !data?.channelSwitch || data.followsUnknown
      ? null
      : data.follows !== undefined
      ? `This machine follows ${data.follows} releases. ${channelWays(data.follows, data.channelSwitch.to)}`
      : `Switched release channel from ${data.channelSwitch.from} to ${data.channelSwitch.to}.`;
    if (argv.includes("--dry-run")) {
      return before === target
        ? successText(
          `You're on the latest version of aidlc (${target}); nothing to update.`,
          process.stdout,
        )
        : warnVerdict(
          `Would update aidlc from ${before ?? "not installed"} to ${target}${
            switchLine && data?.follows === undefined ? ` (switching to the ${data?.channelSwitch?.to} channel)` : ""
          }.`,
          process.stdout,
        );
    }
    if (before === target) {
      return `${successText(
        `You're on the latest ${channelWord}version of aidlc (${target}).`,
        process.stdout,
      )}${pruneLine}`;
    }
    return [
      `Checking for ${channelWord}releases ... ${before ?? "not installed"} -> ${target}`,
      `Downloading aidlc ${target} ... done (verified)`,
      `Staging and switching ... done (${
        before ? `${before} retained` : "no prior version retained"
      })`,
      ...(switchLine ? [switchLine] : []),
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
      recovered?: number;
      warnings?: string[];
      preservedUnowned?: string[];
    } | undefined;
    // A resumed cleanup keeps its own line.
    if (data?.recovered !== undefined) return null;
    // On Windows the files go once this command has exited, so the line says
    // what Windows is about to remove rather than that it is gone, how to tell
    // it is done, and where to look if something stays.
    const removes = (what: string): string =>
      data?.deferred
        ? `Windows removes ${what} after this command ends; it is done when the aidlc command is no longer found.`
        : `Removed ${what}.`;
    const check = data?.deferred ? " If aidlc still runs after a few minutes, aidlc doctor shows what is left." : "";
    const warnings = data?.deferred && data.warnings?.length ? `${data.warnings.join("\n")}\n` : "";
    const machineState = "machine settings, update cache, pins, harness default, and release channel";
    const left = data?.preservedUnowned?.length ? data.preservedUnowned : null;
    const what = left
      ? "the files AI-DLC installed"
      : data?.purge ? "aidlc, all retained releases" : "aidlc and all retained releases";
    return successText(
      `${warnings}${
        data?.purge ? removes(`${what}, ${machineState}`) : `${removes(what)} Kept on purpose: ${machineState}.`
      } Projects are not changed; their aidlc/ records stay with each project.${check}${
        left ? preservedUninstallPaths(left) : ""
      }`,
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
            replaceLauncher: windowsPosixLauncherReplacement(argv),
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
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = EXIT.failure;
  });
}
