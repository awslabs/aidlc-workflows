// core/tools/aidlc-devin-version.ts — Devin CLI version floor check with
// cross-platform Desktop-aware discovery.
//
// Used by the doctor (`/aidlc --doctor` on Devin) to verify the installed
// Devin CLI meets the minimum supported version. Discovery is injectable for
// testing: the doctor passes discovery/execution functions that tests can
// override to simulate missing binaries, broken binaries, malformed output,
// Desktop bundles, etc.
//
// The floor is 3000.5.20 (the minimum version that supports the features
// AIDLC relies on: hooks.v1.json, triggers frontmatter, run_subagent tool,
// ask_user_question with multi_select).
//
// Desktop discovery is cross-platform:
//   - macOS: /Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin
//   - Linux: ~/.local/share/Devin/, /opt/Devin/
//   - Windows: %LOCALAPPDATA%\Devin\, %ProgramFiles%\Devin\
// PATH lookup is always attempted first; Desktop paths are fallbacks.
// Desktop support remains discovery-only (no Desktop execution is verified).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/** The minimum supported Devin CLI version as a numeric triple. */
export const DEVIN_MIN_VERSION: readonly [number, number, number] = [3000, 5, 20];

/** Human-readable floor string for labels. */
export const DEVIN_MIN_VERSION_STRING = DEVIN_MIN_VERSION.join(".");

/** Result of a version check. */
export interface DevinVersionResult {
  /** Whether the check passed (version >= floor, or advisory-only). */
  pass: boolean;
  /** Human-readable label for the doctor output. */
  label: string;
  /** Fix hint when the check fails. */
  fix: string;
  /** The discovered binary path (or null if none found). */
  binaryPath: string | null;
  /** The discovery source ("PATH", "Desktop", or null). */
  source: "PATH" | "Desktop" | null;
  /** The parsed version triple (or null if unparseable). */
  parsedVersion: readonly [number, number, number] | null;
  /** Raw version stdout (sanitized — no stderr or secrets). */
  rawVersion: string | null;
  /** Whether this is an advisory (non-blocking) result. */
  advisory: boolean;
}

/** Injectable discovery function: returns a binary path or null. */
export type DiscoveryFn = () => string | null;

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

/** Cross-platform Desktop bundle discovery.
 *  Returns the first existing Desktop binary path, or null if none found.
 *  Paths are OS-specific:
 *    - macOS: /Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin
 *    - Linux: ~/.local/share/Devin/devin, /opt/Devin/devin
 *    - Windows: %LOCALAPPDATA%\Devin\devin.exe, %ProgramFiles%\Devin\devin.exe
 *  Desktop execution is NOT verified — discovery only. */
export const defaultDesktopDiscovery: DiscoveryFn = () => {
  const plat = platform();
  const candidates: string[] = [];
  if (plat === "darwin") {
    candidates.push(
      "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
    );
  } else if (plat === "linux") {
    candidates.push(join(homedir(), ".local", "share", "Devin", "devin"));
    candidates.push(join("/opt", "Devin", "devin"));
  } else if (plat === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(join(localAppData, "Devin", "devin.exe"));
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(join(programFiles, "Devin", "devin.exe"));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
};

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
      timedOut: r.timedOut ?? false,
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

/** Run the Devin version check with injectable discovery and execution.
 *
 *  Discovery order: PATH first, then Desktop (cross-platform).
 *  Execution: [binary, "--version"], no shell, 10s timeout, stdout/stderr separate.
 *  Result: reports source, checked path, parsed version, and comparison result.
 *  Nonzero exit, spawn error, timeout, or malformed output is an error for the
 *  discovered binary, not "missing". Desktop execution is NOT verified. */
export function checkDevinVersion(
  pathDiscovery: DiscoveryFn = defaultPathDiscovery,
  desktopDiscovery: DiscoveryFn = defaultDesktopDiscovery,
  exec: ExecFn = defaultExec,
): DevinVersionResult {
  // 1. Discover the binary: PATH first, then Desktop.
  const pathBin = pathDiscovery();
  const desktopBin = pathBin ? null : desktopDiscovery();
  const binary = pathBin ?? desktopBin;
  const source: "PATH" | "Desktop" | null =
    binary === null ? null : pathBin ? "PATH" : "Desktop";

  if (binary === null) {
    return {
      pass: false,
      label: "devin CLI not found on PATH or Desktop",
      fix: `install Devin CLI >= ${DEVIN_MIN_VERSION_STRING} (https://devin.ai)`,
      binaryPath: null,
      source: null,
      parsedVersion: null,
      rawVersion: null,
      advisory: false,
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
  const sourceLabel = source === "Desktop" ? " (Desktop)" : "";
  return {
    pass: ok,
    label: ok
      ? `devin CLI version ${versionStr} >= ${DEVIN_MIN_VERSION_STRING}${sourceLabel}`
      : `devin CLI version ${versionStr} < ${DEVIN_MIN_VERSION_STRING}${sourceLabel}`,
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
