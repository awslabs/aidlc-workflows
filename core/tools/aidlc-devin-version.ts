// core/tools/aidlc-devin-version.ts — Devin host checks for the doctor:
// the standalone CLI version floor (PATH-only), independent Devin Desktop
// editor discovery, and the combined host-availability verdict.
//
// Used by the doctor (`/aidlc --doctor` on Devin) to report three rows:
//   - Devin host availability: passes when the standalone CLI is on PATH or
//     the Desktop editor application exists; fails when neither is found.
//   - Standalone devin CLI: PATH discovery (Bun.which) plus a bounded
//     [binary, "--version"] floor check. A missing CLI is advisory —
//     Desktop-only use is supported. A discovered binary that times out,
//     exits nonzero, returns malformed output, or sits below the floor is a
//     hard failure even when Desktop is also installed.
//   - Devin Desktop installation: the actual editor application at
//     OS-appropriate paths — filesystem existence only. It is never inferred
//     from a bundled CLI binary and does not verify that Desktop launched or
//     hosted the current session.
//
// Discovery is injectable for testing: tests override the discovery/exec
// functions to simulate missing binaries, broken binaries, malformed output,
// absent editors, etc.
//
// The shared floor is the selected Devin CLI support baseline, not a claim
// about when required capabilities first appeared. AIDLC relies on
// hooks.v1.json, triggers frontmatter, run_subagent, and
// ask_user_question with multi_select.
//
// Desktop editor candidates (the application itself, never an internal CLI):
//   - macOS: /Applications/Devin.app, then ~/Applications/Devin.app
//   - Linux: /usr/bin/devin-desktop, then /usr/share/devin-desktop/devin-desktop
//     (the devin-desktop package's launcher/application paths — best-effort;
//     no Devin Desktop install observed on Linux)
//   - Windows: %LOCALAPPDATA%\Programs\Devin\Devin.exe (verified against a
//     real install), then %ProgramFiles%\Devin\Devin.exe
// Desktop support remains discovery-only (no Desktop execution is verified).

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { homedir, platform } from "node:os";

/** The minimum supported Devin CLI version as a numeric triple. */
export const DEVIN_MIN_VERSION: readonly [number, number, number] = [3000, 10, 21];

/** Human-readable floor string for labels. */
export const DEVIN_MIN_VERSION_STRING = DEVIN_MIN_VERSION.join(".");

/** Result of a version check. */
export interface DevinVersionResult {
  /** Whether the check passed (version >= floor). */
  pass: boolean;
  /** Advisory severity: "warn" when the standalone CLI is simply absent. */
  severity?: "warn";
  /** Human-readable label for the doctor output. */
  label: string;
  /** Fix hint when the check fails. */
  fix: string;
  /** The discovered binary path (or null if none found). */
  binaryPath: string | null;
  /** The discovery source ("PATH" or null — discovery is PATH-only). */
  source: "PATH" | null;
  /** The parsed version triple (or null if unparseable). */
  parsedVersion: readonly [number, number, number] | null;
  /** Raw version stdout (sanitized — no stderr or secrets). */
  rawVersion: string | null;
  /** Whether this is an advisory (non-blocking) result. */
  advisory: boolean;
}

export interface DevinDesktopResult {
  pass: boolean;
  severity?: "warn";
  label: string;
  fix?: string;
  appPath: string | null;
}

export interface DevinHostAvailabilityResult {
  pass: boolean;
  label: string;
  fix?: string;
}

/** Injectable discovery function: returns a binary path or null. */
export type DiscoveryFn = () => string | null;

export type DesktopAppDiscoveryFn = () => string | null;

/** Injectable execution function: returns { stdout, stderr, exitCode, timedOut }.
 *  Must invoke [binary, "--version"] without shell interpolation. */
export type ExecFn = (
  binary: string,
) => { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

/** Default PATH discovery using Bun.which. Falls back to null if not found. */
export const defaultPathDiscovery: DiscoveryFn = () => {
  try {
    const p = Bun.which("devin");
    return p ?? null;
  } catch {
    return null;
  }
};

/** Devin Desktop editor candidate paths for a platform, in probe order.
 *  These are the actual application paths — never an internal/bundled CLI
 *  binary, which proves nothing about whether the editor is installed.
 *  Windows candidates come from environment variables so a missing
 *  LOCALAPPDATA/ProgramFiles simply drops that candidate. */
export function devinDesktopAppCandidates(
  targetPlatform: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (targetPlatform === "darwin") {
    return [
      "/Applications/Devin.app",
      posix.join(home, "Applications", "Devin.app"),
    ];
  }
  if (targetPlatform === "linux") {
    return [
      "/usr/bin/devin-desktop",
      "/usr/share/devin-desktop/devin-desktop",
    ];
  }
  if (targetPlatform === "win32") {
    const candidates: string[] = [];
    if (env.LOCALAPPDATA) {
      candidates.push(win32.join(env.LOCALAPPDATA, "Programs", "Devin", "Devin.exe"));
    }
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
    if (programFiles) {
      candidates.push(win32.join(programFiles, "Devin", "Devin.exe"));
    }
    return candidates;
  }
  return [];
}

export const defaultDesktopAppDiscovery: DesktopAppDiscoveryFn = () =>
  devinDesktopAppCandidates().find((candidate) => existsSync(candidate)) ?? null;

export function checkDevinDesktop(
  discovery: DesktopAppDiscoveryFn = defaultDesktopAppDiscovery,
): DevinDesktopResult {
  const appPath = discovery();
  if (appPath) {
    return {
      pass: true,
      label: `Devin Desktop installation: found at ${appPath} (filesystem discovery only; launch/session execution not verified)`,
      appPath,
    };
  }
  return {
    pass: false,
    severity: "warn",
    label: "Devin Desktop installation: not found (checked OS-appropriate application paths; CLI-only use remains supported)",
    fix: "Install Devin Desktop if this project is intended for Desktop use; CLI-only Devin projects can ignore this warning.",
    appPath: null,
  };
}

export function checkDevinHostAvailability(
  standaloneCliPath: string | null,
  desktopAppPath: string | null,
): DevinHostAvailabilityResult {
  if (standaloneCliPath || desktopAppPath) {
    const hosts = [
      standaloneCliPath ? "standalone CLI" : null,
      desktopAppPath ? "Desktop editor" : null,
    ].filter((host): host is string => host !== null);
    return {
      pass: true,
      label: `Devin host availability: ${hosts.join(" and ")} found`,
    };
  }
  return {
    pass: false,
    label: "Devin host availability: neither standalone CLI nor Desktop editor found",
    fix: "Install Devin Desktop or the standalone Devin CLI, then rerun /aidlc --doctor.",
  };
}

/** Default execution: invokes [binary, "--version"] with a 10s timeout,
 *  capturing stdout and stderr separately. No shell interpolation. */
export const defaultExec: ExecFn = (binary: string) => {
  try {
    const r = Bun.spawnSync([binary, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      exitCode: r.exitCode ?? null,
      timedOut: r.exitedDueToTimeout ?? false,
    };
  } catch (e) {
    return {
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: null,
      timedOut: false,
    };
  }
};

/** Parse a version string like "devin 3000.6.14 (18033302)" into a numeric triple.
 *  Returns null if no valid triple is found. */
export function parseVersionTriple(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two numeric triples lexicographically.
 *  Returns: negative if a < b, 0 if equal, positive if a > b. */
export function compareTriples(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Run the standalone Devin CLI version check with injectable discovery and
 *  execution.
 *
 *  Discovery: PATH only (the standalone CLI). A missing CLI is advisory
 *  (severity "warn") — Desktop-only use is supported, and the Devin host
 *  availability row carries the hard failure when neither host exists.
 *  Execution: [binary, "--version"], no shell, 10s timeout, stdout/stderr separate.
 *  Nonzero exit, spawn error, timeout, or malformed output is an error for
 *  the discovered binary, not "missing": installed but broken or
 *  unsupported is never silently accepted. */
export function checkDevinVersion(
  pathDiscovery: DiscoveryFn = defaultPathDiscovery,
  exec: ExecFn = defaultExec,
): DevinVersionResult {
  // 1. Discover the standalone CLI on PATH.
  const binary = pathDiscovery();
  const source: "PATH" | null = binary === null ? null : "PATH";

  if (binary === null) {
    return {
      pass: false,
      severity: "warn",
      label: "Standalone devin CLI not found on PATH",
      fix: `install the standalone Devin CLI >= ${DEVIN_MIN_VERSION_STRING} (https://devin.ai); Devin Desktop-only use is also supported`,
      binaryPath: null,
      source: null,
      parsedVersion: null,
      rawVersion: null,
      advisory: true,
    };
  }

  // 2. Execute [binary, "--version"] with separate stdout/stderr capture.
  const result = exec(binary);
  const rawStdout = result.stdout.trim();

  // 3. Handle execution failures (nonzero exit, timeout, spawn error).
  if (result.timedOut) {
    return {
      pass: false,
      label: `devin CLI at ${binary} timed out (--version did not respond in 10s)`,
      fix: "check the Devin CLI installation; a hung binary cannot be verified",
      binaryPath: binary,
      source,
      parsedVersion: null,
      rawVersion: null,
      advisory: false,
    };
  }
  if (result.exitCode !== 0) {
    // Nonzero exit is an error for the discovered binary, not "missing".
    // Do not expose stderr (may contain secrets or unrelated output).
    return {
      pass: false,
      label: `devin CLI at ${binary} exited with code ${result.exitCode} on --version`,
      fix: "reinstall or repair the Devin CLI; a broken binary cannot be verified",
      binaryPath: binary,
      source,
      parsedVersion: null,
      rawVersion: rawStdout || null,
      advisory: false,
    };
  }

  // 4. Parse the version triple from stdout.
  const parsed = parseVersionTriple(rawStdout);
  if (parsed === null) {
    return {
      pass: false,
      label: `devin CLI at ${binary} returned unparseable version output: "${rawStdout.slice(0, 80)}"`,
      fix: "reinstall Devin CLI; the --version output format is unrecognized",
      binaryPath: binary,
      source,
      parsedVersion: null,
      rawVersion: rawStdout || null,
      advisory: false,
    };
  }

  // 5. Compare against the floor.
  const cmp = compareTriples(parsed, DEVIN_MIN_VERSION);
  const ok = cmp >= 0;
  const versionStr = parsed.join(".");
  return {
    pass: ok,
    label: ok
      ? `devin CLI version ${versionStr} >= ${DEVIN_MIN_VERSION_STRING}`
      : `devin CLI version ${versionStr} < ${DEVIN_MIN_VERSION_STRING}`,
    fix: ok
      ? ""
      : `upgrade Devin CLI to ${DEVIN_MIN_VERSION_STRING} or later`,
    binaryPath: binary,
    source,
    parsedVersion: parsed,
    rawVersion: rawStdout,
    advisory: false,
  };
}
