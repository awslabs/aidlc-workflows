import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { requireVersion, VERSION_ID } from "./aidlc-channel.ts";
import { projectionFiles, sha256File, walkFiles } from "./aidlc-distribution.ts";

// Machine roots are canonical paths. Every derived path (launcher body, the
// active-executable pointer, pin targets, registry keys) is rendered from them,
// so equivalent spellings of the same directories (macOS /tmp and /private/tmp,
// a symlinked XDG_DATA_HOME, a re-spelled AIDLC_INSTALL_ROOT) describe one
// install instead of rejecting each other's launcher as tampered.
function lexicalInstallRoot(): string {
  const explicit = process.env.AIDLC_INSTALL_ROOT?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "aidlc");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "aidlc");
}

export function installRoot(): string {
  return canonicalPolicyPath(lexicalInstallRoot());
}

export function versionsRoot(): string {
  return join(installRoot(), "versions");
}

export function versionRoot(version: string): string {
  return join(versionsRoot(), requireVersion(version));
}

function lexicalBinRoot(): string {
  const explicit = process.env.AIDLC_BIN_DIR?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  return platform() === "win32"
    ? join(lexicalInstallRoot(), "bin")
    : join(homedir(), ".local", "bin");
}

export function binRoot(): string {
  return canonicalPolicyPath(lexicalBinRoot());
}

export function canonicalPolicyPath(path: string): string {
  const absolute = resolve(path);
  let cursor = absolute;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return suffix.reduce((current, entry) => join(current, entry), base);
}

export function policyPathWithin(path: string, root: string): boolean {
  const rel = relative(canonicalPolicyPath(root), canonicalPolicyPath(path));
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function resolvedPathWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function isMachineOwnedPath(path: string): boolean {
  return [installRoot(), binRoot()].some((root) => policyPathWithin(path, root));
}

// A project overlaps the machine roots when either contains the other. The
// configured (lexical) spellings are checked alongside the canonical ones, and
// the engine's workspace `<project>/aidlc` is resolved as well: whether the
// root is configured as that symlink or as the real tree it points to, writes
// under `<project>/aidlc` would land in the machine tree (t230 covers both).
export function projectPathOverlapsMachineRoots(projectDir: string): boolean {
  const lexical = [lexicalInstallRoot(), lexicalBinRoot()];
  const roots = new Set([...lexical, ...lexical.map(canonicalPolicyPath)]);
  const workspace = join(projectDir, "aidlc");
  return [...roots].some((root) =>
    policyPathWithin(projectDir, root) ||
    policyPathWithin(root, projectDir) ||
    resolvedPathWithin(projectDir, root) ||
    resolvedPathWithin(root, projectDir) ||
    policyPathWithin(workspace, root)
  );
}

export function machineTransactionRoot(): string {
  const paths = [installRoot(), binRoot()].map((path) => resolve(path));
  const filesystemRoot = parse(paths[0]).root;
  if (paths.some((path) => parse(path).root !== filesystemRoot)) {
    throw new Error("machine install and command directories must be on one filesystem root");
  }
  const parts = paths.map((path) =>
    path.slice(filesystemRoot.length).split(/[\\/]/).filter(Boolean)
  );
  const shared: string[] = [];
  for (let index = 0; index < Math.min(...parts.map((value) => value.length)); index++) {
    if (parts.some((value) => value[index] !== parts[0][index])) break;
    shared.push(parts[0][index]);
  }
  const common = join(filesystemRoot, ...shared);
  if (common === filesystemRoot) {
    throw new Error("machine install and command directories need a writable shared parent");
  }
  return common;
}

export function commandPath(): string {
  return join(binRoot(), platform() === "win32" ? "aidlc.cmd" : "aidlc");
}

// A POSIX-shell launcher installed on Windows ALONGSIDE aidlc.cmd. CMD and
// PowerShell resolve a bare `aidlc` through PATHEXT to aidlc.cmd, but Git Bash
// and other MSYS shells use execvp PATH lookup and ignore PATHEXT, so a bare
// `aidlc` there finds nothing. This extensionless sibling makes `aidlc`
// resolve in those shells. It is null off Windows, where commandPath() is
// already the extensionless launcher.
export function windowsPosixCommandPath(): string | null {
  return platform() === "win32" ? join(binRoot(), "aidlc") : null;
}

// The POSIX-shell launcher installed alongside aidlc.cmd on Windows so a bare
// `aidlc` resolves in Git Bash / MSYS shells (which ignore PATHEXT). It simply
// forwards to its sibling aidlc.cmd, which runs the same aidlc-shim.ps1 chain.
// The body is location-independent ($0's directory), so it is a constant both
// the install-time ownership check and the uninstall plan compare against
// verbatim, exactly like the other shims. Lives here (not in lifecycle) so the
// uninstall plan can reference it without a circular import.
// LF line endings: MSYS /bin/sh rejects a CRLF script (\r joins the shebang).
//
// $0 hardening (solves the same $0-resolution problem the npm/yarn Git Bash
// shims do, but hardened further): a PATH-resolved bare invocation sets $0 to
// the full resolved path, but the separator style is not guaranteed, so we
// normalise backslashes to slashes first. If $0 still carries no directory
// separator we FAIL LOUDLY rather than let `dirname` collapse to "." and exec a
// CWD-relative ./aidlc.cmd -- that fallback would both break the launcher and
// let an attacker-planted aidlc.cmd in the current directory run.
//
// The backslash-to-slash normalisation uses a pure POSIX parameter-expansion
// loop rather than `tr "\\" "/"`: GNU tr (as shipped in MSYS) prints
// "warning: an unescaped backslash at end of string is not portable" to stderr
// on the single-backslash operand, on EVERY launch, which would spam every hook
// invocation. The loop also removes the external-command dependency, so the
// forwarder works in a stripped MSYS that lacks tr. Manually spot-checked on
// Windows Server 2022 Git Bash (MINGW64) — zero warnings, identical output;
// CI exercises the loop via a POSIX /bin/sh test, not MINGW64 itself.
export function windowsPosixShim(): string {
  return [
    "#!/bin/sh",
    "# aidlc-gitbash-forwarder-v3",
    "self=$0",
    // Replace each backslash with a slash using only shell builtins. The
    // pattern `${self#*\\}` (strip up to the first backslash) is split so the
    // source carries no literal `${` bigram for the lint's template-curly
    // heuristic to misfire on; the rendered lines are byte-identical.
    "norm=''",
    'while [ "$self" != "$' + '{self#*\\\\}" ]; do',
    '  norm="$norm$' + '{self%%\\\\*}/"',
    '  self="$' + '{self#*\\\\}"',
    "done",
    'self="$norm$self"',
    'case "$self" in',
    // The exec target is `"${self%/*}/aidlc.cmd"` — split here so the source
    // has no literal `${` bigram for the lint's template-curly heuristic to
    // misfire on; the rendered line is byte-identical.
    '  */*) exec "$' + '{self%/*}/aidlc.cmd" "$@" ;;',
    '  *) echo "aidlc: cannot locate launcher directory from \\$0 ($0)" >&2; exit 1 ;;',
    "esac",
    "",
  ].join("\n");
}

// Forwarder bodies this installer has written in earlier revisions. The
// ownership check treats a file matching ANY of these (or the current
// windowsPosixShim()) as installer-owned, so a body change does NOT strand an
// existing install: the next activation recognises the stale-but-ours forwarder
// and overwrites it in place, rather than refusing to touch a "foreign" file.
// Without this list, bumping the body marker would self-lock activation on every
// machine carrying the previous body. Append the OLD body here whenever the
// current one changes; never remove an entry (an old install may still carry it).
export function previousWindowsPosixShims(): readonly string[] {
  return [
    // v2 — normalised backslashes via `tr "\\" "/"`, which emitted a per-launch
    // GNU-tr stderr warning in MSYS; superseded by the v3 builtin loop.
    [
      "#!/bin/sh",
      "# aidlc-gitbash-forwarder-v2",
      'self=$(printf %s "$0" | tr "\\\\" "/")',
      'case "$self" in',
      '  */*) exec "$' + '{self%/*}/aidlc.cmd" "$@" ;;',
      '  *) echo "aidlc: cannot locate launcher directory from \\$0 ($0)" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  ];
}

// Single source of truth for "is this forwarder body one the installer wrote":
// the current render OR any historical body. Pure (no I/O) so both the lifecycle
// activation guard and the uninstall plan compare through it — one predicate, no
// desync between install and uninstall.
export function windowsPosixLauncherBodyIsOwned(body: string): boolean {
  return body === windowsPosixShim() || previousWindowsPosixShims().includes(body);
}

export type WindowsGitBashLauncherState =
  | { ok: true }
  | { ok: false; launcher: string; foreign: boolean; fix: string };

// Whether Git Bash, where Claude Code runs its hooks on Windows, can run a bare
// `aidlc` from this native install: only through the extensionless launcher
// beside aidlc.cmd. Null off Windows and when there is no native command here.
export function windowsGitBashLauncherState(): WindowsGitBashLauncherState | null {
  const launcher = windowsPosixCommandPath();
  if (launcher === null || !existsSync(commandPath())) return null;
  let version: string | null = null;
  try {
    version = readVersionMarker(activeVersionPath());
  } catch {
    // The fix falls back to the installer.
  }
  const repair = version ? `run \`aidlc use ${version}\`` : "rerun the AI-DLC installer (install.ps1)";
  let body: string | null = null;
  let present = false;
  try {
    const info = lstatSync(launcher);
    present = true;
    if (info.isFile()) body = readFileSync(launcher, "utf-8");
  } catch {
    // Missing.
  }
  if (body !== null && windowsPosixLauncherBodyIsOwned(body)) return { ok: true };
  return present
    ? { ok: false, launcher, foreign: true, fix: `move ${launcher} aside, then ${repair}` }
    : { ok: false, launcher, foreign: false, fix: repair };
}

// The hooks' fix when Git Bash cannot run `aidlc` (then no hook runs there),
// or null when that is not the cause: callers name it before generic advice.
export function gitBashLauncherRecovery(): string | null {
  const state = windowsGitBashLauncherState();
  if (state === null || state.ok) return null;
  return `Git Bash cannot run a bare \`aidlc\`, so no hook runs: ${state.fix}`;
}

export function packageManagerForExecutable(
  executable: string,
): { name: string; remediation: string } | null {
  let path = resolve(executable);
  try {
    path = realpathSync(path);
  } catch {
    // A missing executable is not manager-owned.
  }
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.includes("/Cellar/") ||
    normalized.startsWith("/opt/homebrew/") ||
    normalized.startsWith("/home/linuxbrew/.linuxbrew/")
  ) {
    return { name: "Homebrew", remediation: "brew upgrade aidlc" };
  }
  if (normalized.startsWith("/nix/store/") || normalized.includes("/.nix-profile/")) {
    return { name: "Nix", remediation: "upgrade aidlc through Nix" };
  }
  return null;
}

export function activeVersionPath(): string {
  return join(installRoot(), "active-version");
}

export function activeExecutablePath(): string {
  return join(installRoot(), "active-executable");
}

export function projectPinTargetPath(projectDir: string): string {
  return join(resolve(projectDir), "aidlc", ".aidlc-sessions", "pin-target");
}

export function windowsUninstallFencePath(): string {
  const key = createHash("sha256")
    .update(resolve(installRoot()))
    .digest("hex")
    .slice(0, 16);
  return join(machineTransactionRoot(), `.aidlc-uninstall-${key}.json`);
}

export function rollbackVersionPath(): string {
  return join(installRoot(), "rollback-version");
}

export function readVersionMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return VERSION_ID.test(value) ? value : null;
}

export function activeVersion(): string | null {
  try {
    const executable = readActiveExecutable();
    if (executable) return basename(dirname(executable));
  } catch {
    // The marker fallback lets doctor report a damaged pointer.
  }
  for (const candidatePath of [process.execPath, commandPath()]) {
    try {
      const executable = realpathSync(candidatePath);
      const parent = dirname(executable);
      const candidate = basename(parent);
      if (dirname(parent) === realpathOrResolved(versionsRoot()) && VERSION_ID.test(candidate)) {
        return candidate;
      }
    } catch {
      // The command link does not exist before the first install.
    }
  }
  return readVersionMarker(activeVersionPath());
}

export function readActiveExecutable(): string | null {
  const path = activeExecutablePath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  if (!/^[^\r\n]+\r?\n?$/.test(raw)) {
    throw new Error(`${path} must contain exactly one executable path`);
  }
  const executable = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
    ? raw.slice(0, -1)
    : raw;
  if (!isAbsolute(executable)) {
    throw new Error(`${path} must contain an absolute executable path`);
  }
  const normalized = canonicalPolicyPath(executable);
  const parent = dirname(normalized);
  const version = basename(parent);
  const expectedName = platform() === "win32" ? "aidlc.exe" : "aidlc";
  if (
    basename(normalized).toLowerCase() !== expectedName ||
    dirname(parent) !== resolve(versionsRoot()) ||
    !VERSION_ID.test(version)
  ) {
    throw new Error(`${path} points outside the installed versions root`);
  }
  return normalized;
}

export function inspectProjectPinTarget(
  projectDir: string,
  version: string,
): { valid: boolean; target: string; reason?: string } {
  const path = projectPinTargetPath(projectDir);
  if (!existsSync(path)) {
    return { valid: false, target: path, reason: "resolved target marker is missing" };
  }
  let raw: string;
  try {
    if (!statSync(path).isFile()) {
      return { valid: false, target: path, reason: "resolved target marker is not a regular file" };
    }
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    return {
      valid: false,
      target: path,
      reason: `resolved target marker is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!/^[^\r\n]+\r?\n?$/.test(raw)) {
    return { valid: false, target: path, reason: "resolved target marker must contain one path" };
  }
  const target = canonicalPolicyPath(raw.replace(/\r?\n$/, ""));
  const expected = canonicalPolicyPath(installedExecutablePath(version));
  if (target !== expected) {
    return {
      valid: false,
      target,
      reason: `resolved target does not select retained version ${version}`,
    };
  }
  try {
    const stat = statSync(target);
    if (!stat.isFile()) {
      return { valid: false, target, reason: "resolved target is not a regular file" };
    }
    if (platform() !== "win32" && (stat.mode & 0o111) === 0) {
      return { valid: false, target, reason: "resolved target is not executable" };
    }
  } catch {
    return { valid: false, target, reason: "resolved target is missing" };
  }
  return { valid: true, target };
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function runtimeRoot(version: string): string {
  return join(versionRoot(version), "runtime");
}

export function installedExecutablePath(version: string): string {
  return join(versionRoot(version), platform() === "win32" ? "aidlc.exe" : "aidlc");
}

export type InstalledRuntimeIntegrity = {
  schemaVersion: 1;
  version: string;
  files: Array<{
    path: string;
    mode: number;
    sha256: string;
  }>;
};

export function runtimeIntegrityPath(version: string): string {
  return join(versionRoot(version), "runtime-integrity.json");
}

export function createRuntimeIntegrity(
  version: string,
  root = runtimeRoot(version),
): InstalledRuntimeIntegrity {
  requireVersion(version);
  return {
    schemaVersion: 1,
    version,
    files: walkFiles(root).map((file) => {
      const path = join(root, file);
      return {
        path: file.replaceAll("\\", "/"),
        mode: statSync(path).mode & 0o777,
        sha256: sha256File(path),
      };
    }),
  };
}

export function installedVersionFingerprint(version: string): string | null {
  try {
    const root = versionRoot(version);
    const rows = walkFiles(root).map((file) => {
      const path = join(root, file);
      return `${file.replaceAll("\\", "/")}:${statSync(path).mode & 0o777}:${sha256File(path)}`;
    });
    return createHash("sha256").update(rows.join("\n")).digest("hex");
  } catch {
    return null;
  }
}

export function inspectInstalledVersion(
  version: string,
  requiredDistribution?: string | null,
): { complete: boolean; distributions: string[]; reason?: string } {
  requireVersion(version);
  const executable = installedExecutablePath(version);
  const manifestPath = join(versionRoot(version), "version.json");
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    return { complete: false, distributions: [], reason: "executable is missing" };
  }
  if (platform() !== "win32" && (statSync(executable).mode & 0o111) === 0) {
    return { complete: false, distributions: [], reason: "executable mode is invalid" };
  }
  let manifest: {
    schemaVersion?: unknown;
    version?: unknown;
    distributions?: unknown;
    assets?: unknown;
    installedRuntime?: unknown;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as typeof manifest;
  } catch {
    return { complete: false, distributions: [], reason: "version.json is missing or malformed" };
  }
  if (manifest.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.assets)) {
    return { complete: false, distributions: [], reason: "version.json identity is invalid" };
  }
  const binaryName = `aidlc-${targetTriple()}${platform() === "win32" ? ".exe" : ""}`;
  const binary = manifest.assets.find((asset): asset is { name: string; sha256: string } =>
    Boolean(asset) &&
    typeof asset === "object" &&
    (asset as { name?: unknown }).name === binaryName &&
    /^[a-f0-9]{64}$/.test(String((asset as { sha256?: unknown }).sha256 ?? ""))
  );
  if (
    !binary ||
    createHash("sha256").update(readFileSync(executable)).digest("hex") !== binary.sha256
  ) {
    return { complete: false, distributions: [], reason: "executable does not match version.json" };
  }
  const runtime = runtimeRoot(version);
  if (!existsSync(runtime)) {
    return { complete: false, distributions: [], reason: "runtime directory is missing" };
  }
  const runtimeAssetDeclared = manifest.assets.some((asset) =>
    Boolean(asset) &&
    typeof asset === "object" &&
    (asset as { name?: unknown }).name === `aidlc-runtime-${version}.tar.gz`
  );
  if (runtimeAssetDeclared || manifest.installedRuntime !== undefined) {
    const installedRuntime = manifest.installedRuntime as {
      schemaVersion?: unknown;
      baseline?: unknown;
      sha256?: unknown;
    } | undefined;
    if (
      installedRuntime?.schemaVersion !== 1 ||
      installedRuntime.baseline !== "runtime-integrity.json" ||
      typeof installedRuntime.sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(installedRuntime.sha256)
    ) {
      return {
        complete: false,
        distributions: [],
        reason: "installed runtime integrity metadata is missing or invalid",
      };
    }
    const baselinePath = runtimeIntegrityPath(version);
    let baseline: InstalledRuntimeIntegrity;
    try {
      if (!statSync(baselinePath).isFile()) {
        return {
          complete: false,
          distributions: [],
          reason: "runtime integrity baseline is not a regular file",
        };
      }
      if (sha256File(baselinePath) !== installedRuntime.sha256) {
        return {
          complete: false,
          distributions: [],
          reason: "runtime integrity baseline does not match version.json",
        };
      }
      baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as InstalledRuntimeIntegrity;
    } catch {
      return {
        complete: false,
        distributions: [],
        reason: "runtime integrity baseline is missing or malformed",
      };
    }
    if (
      baseline.schemaVersion !== 1 ||
      baseline.version !== version ||
      !Array.isArray(baseline.files)
    ) {
      return {
        complete: false,
        distributions: [],
        reason: "runtime integrity baseline identity is invalid",
      };
    }
    let actual: InstalledRuntimeIntegrity;
    try {
      actual = createRuntimeIntegrity(version, runtime);
    } catch (error) {
      return {
        complete: false,
        distributions: [],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (baseline.files.length !== actual.files.length) {
      return {
        complete: false,
        distributions: [],
        reason: "runtime file inventory does not match the installed baseline",
      };
    }
    for (let index = 0; index < actual.files.length; index++) {
      const expected = baseline.files[index];
      const current = actual.files[index];
      if (
        !expected ||
        typeof expected.path !== "string" ||
        !Number.isInteger(expected.mode) ||
        typeof expected.sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(expected.sha256)
      ) {
        return {
          complete: false,
          distributions: [],
          reason: "runtime integrity baseline contains an invalid file entry",
        };
      }
      if (expected.path !== current.path) {
        return {
          complete: false,
          distributions: [],
          reason: "runtime file inventory does not match the installed baseline",
        };
      }
      if (expected.mode !== current.mode || expected.sha256 !== current.sha256) {
        return {
          complete: false,
          distributions: [],
          reason: `runtime file ${current.path} does not match the installed baseline`,
        };
      }
    }
  }
  const declared = new Set(
    Array.isArray(manifest.distributions)
      ? manifest.distributions.flatMap((entry) =>
          entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
            ? [(entry as { name: string }).name]
            : []
        )
      : [],
  );
  const distributions: string[] = [];
  try {
    for (const distribution of readdirSync(runtime).sort()) {
      const root = join(runtime, distribution);
      if (!statSync(root).isDirectory() || !declared.has(distribution)) {
        return { complete: false, distributions, reason: `runtime ${distribution} is not declared` };
      }
      const { stamp } = projectionFiles(root);
      if (stamp.frameworkVersion !== version || stamp.distribution !== distribution) {
        return { complete: false, distributions, reason: `runtime ${distribution} stamp is invalid` };
      }
      distributions.push(distribution);
    }
  } catch (error) {
    return {
      complete: false,
      distributions,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const missing = [...declared].filter((distribution) =>
    !distributions.includes(distribution)
  ).sort();
  if (missing.length > 0) {
    return {
      complete: false,
      distributions,
      reason: `declared runtime is missing: ${missing.join(", ")}`,
    };
  }
  if (requiredDistribution && !distributions.includes(requiredDistribution)) {
    return {
      complete: false,
      distributions,
      reason: `${requiredDistribution} runtime is not installed`,
    };
  }
  return { complete: true, distributions };
}

export function targetTriple(): string {
  const os = platform() === "darwin" ? "darwin" : platform() === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const muslArch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const muslLoader = os === "linux" && [
    "/lib/ld-musl-" + muslArch + ".so.1",
    "/usr/lib/ld-musl-" + muslArch + ".so.1",
    "/lib/libc.musl-" + muslArch + ".so.1",
    "/usr/lib/libc.musl-" + muslArch + ".so.1",
  ].some(existsSync);
  // Bun-compiled binaries may not expose process.report; absence alone does not mean musl.
  const libc = process.env.AIDLC_LIBC?.trim().toLowerCase() ||
    (os === "linux" && !report?.header?.glibcVersionRuntime && muslLoader ? "musl" : "glibc");
  return os + "-" + arch + (os === "linux" && libc === "musl" ? "-musl" : "");
}

// Only a `--project-dir` before the `--` delimiter selects the project; tokens
// after it are literal text and must never reroute a lifecycle or pin decision.
export function projectDirFrom(argv: readonly string[]): string {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const index = options.indexOf("--project-dir");
  const explicit = index >= 0 ? options[index + 1] : undefined;
  const value = explicit || process.env.AIDLC_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR || process.env.KIRO_PROJECT_DIR;
  return value ? (isAbsolute(value) ? value : resolve(process.cwd(), value)) : process.cwd();
}
