// t334-devin-version: unit tests for the Devin host checks
// (core/tools/aidlc-devin-version.ts).
//
// covers: file:core/tools/aidlc-devin-version.ts
//
// WHAT. The doctor reports three independent Devin host rows:
//   - Devin host availability: passes when the standalone CLI is on PATH or
//     the Desktop editor application exists; fails when neither is found.
//   - standalone devin CLI: PATH-only discovery plus a [binary, "--version"]
//     floor check. Missing is advisory (Desktop-only use is supported); a
//     discovered binary that is broken, unparseable, or below the floor is a
//     hard failure even when Desktop is also installed.
//   - Devin Desktop installation: the actual editor application at
//     OS-appropriate paths — filesystem existence only, never an internal
//     bundled CLI. Absence is advisory (CLI-only use is supported).
// These tests verify the exact four-case host matrix (CLI only / Desktop
// only / both / neither), every version-check outcome, and the OS candidate
// lists using injectable discovery/exec seams.
//
// WHY UNIT (not subprocess). The helper's discovery and execution are injectable.
// Tests override them with deterministic stubs — no real binary needed, no
// platform dependency, no timeout flakiness.

import { describe, expect, test } from "bun:test";
import {
  checkDevinDesktop,
  checkDevinHostAvailability,
  checkDevinVersion,
  compareTriples,
  devinDesktopAppCandidates,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
  type DesktopAppDiscoveryFn,
  type DiscoveryFn,
  type ExecFn,
} from "../../core/tools/aidlc-devin-version.ts";

describe("t334 devin host checks — four-case matrix and version outcomes", () => {
  // Helper: create an ExecFn that returns a fixed result.
  function execReturning(result: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
  }): ExecFn {
    return () => ({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
      timedOut: result.timedOut ?? false,
    });
  }

  const noPath: DiscoveryFn = () => null;
  const pathBin: DiscoveryFn = () => "/usr/local/bin/devin";
  const noDesktopApp: DesktopAppDiscoveryFn = () => null;
  const desktopApp: DesktopAppDiscoveryFn = () =>
    "C:\\Users\\test\\AppData\\Local\\Programs\\Devin\\Devin.exe";
  const validExec = execReturning({ stdout: "devin 3000.10.22 (18033302)\n" });

  test("1: CLI only — availability pass, CLI pass, Desktop warn", () => {
    const ver = checkDevinVersion(pathBin, validExec);
    const desktop = checkDevinDesktop(noDesktopApp);
    const avail = checkDevinHostAvailability(ver.binaryPath, desktop.appPath);
    expect(ver.pass).toBe(true);
    expect(ver.source).toBe("PATH");
    expect(ver.severity).toBeUndefined();
    expect(desktop.pass).toBe(false);
    expect(desktop.severity).toBe("warn");
    expect(avail.pass).toBe(true);
    expect(avail.label).toBe("Devin host availability: standalone CLI found");
  });

  test("2: Desktop only — availability pass, CLI warn, Desktop pass", () => {
    const ver = checkDevinVersion(noPath, validExec);
    const desktop = checkDevinDesktop(desktopApp);
    const avail = checkDevinHostAvailability(ver.binaryPath, desktop.appPath);
    expect(ver.pass).toBe(false);
    expect(ver.severity).toBe("warn");
    expect(ver.label).toContain("Standalone devin CLI not found on PATH");
    expect(desktop.pass).toBe(true);
    expect(avail.pass).toBe(true);
    expect(avail.label).toBe("Devin host availability: Desktop editor found");
  });

  test("3: both — availability pass, CLI pass from PATH, Desktop pass", () => {
    const ver = checkDevinVersion(pathBin, validExec);
    const desktop = checkDevinDesktop(desktopApp);
    const avail = checkDevinHostAvailability(ver.binaryPath, desktop.appPath);
    expect(ver.pass).toBe(true);
    expect(ver.source).toBe("PATH");
    expect(desktop.pass).toBe(true);
    expect(avail.pass).toBe(true);
    expect(avail.label).toBe(
      "Devin host availability: standalone CLI and Desktop editor found",
    );
  });

  test("4: neither — availability fails, both component rows warn", () => {
    const ver = checkDevinVersion(noPath, validExec);
    const desktop = checkDevinDesktop(noDesktopApp);
    const avail = checkDevinHostAvailability(ver.binaryPath, desktop.appPath);
    expect(ver.pass).toBe(false);
    expect(ver.severity).toBe("warn");
    expect(desktop.pass).toBe(false);
    expect(desktop.severity).toBe("warn");
    expect(avail.pass).toBe(false);
    expect(avail.label).toContain(
      "neither standalone CLI nor Desktop editor found",
    );
    expect(avail.fix).toContain(
      "Install Devin Desktop or the standalone Devin CLI",
    );
  });

  test("5: below-floor CLI stays a hard failure even with Desktop installed", () => {
    // The CLI exists, so availability passes — but installed-yet-unsupported
    // must fail the version row, never be silently accepted.
    const ver = checkDevinVersion(
      pathBin,
      execReturning({ stdout: "devin 3000.10.20 (12345)\n" }),
    );
    const desktop = checkDevinDesktop(desktopApp);
    const avail = checkDevinHostAvailability(ver.binaryPath, desktop.appPath);
    expect(avail.pass).toBe(true);
    expect(ver.pass).toBe(false);
    expect(ver.severity).toBeUndefined();
    expect(ver.parsedVersion).toEqual([3000, 10, 20]);
    expect(ver.label).toContain("3000.10.20");
    expect(ver.label).toContain("<");
    expect(ver.fix).toContain("upgrade");
    expect(ver.fix).toContain(DEVIN_MIN_VERSION_STRING);
  });

  test("6: PATH binary found, version above floor", () => {
    const r = checkDevinVersion(pathBin, validExec);
    expect(r.pass).toBe(true);
    expect(r.binaryPath).toBe("/usr/local/bin/devin");
    expect(r.source).toBe("PATH");
    expect(r.severity).toBeUndefined();
    expect(r.parsedVersion).toEqual([3000, 10, 22]);
    expect(r.label).toContain("3000.10.22");
    expect(r.label).toContain(">=");
    expect(r.label).toContain(DEVIN_MIN_VERSION_STRING);
  });

  test("7: missing CLI is advisory warn, not a hard failure", () => {
    const r = checkDevinVersion(noPath, validExec);
    expect(r.pass).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.advisory).toBe(true);
    expect(r.binaryPath).toBeNull();
    expect(r.source).toBeNull();
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("Standalone devin CLI not found on PATH");
    expect(r.fix).toContain(DEVIN_MIN_VERSION_STRING);
    expect(r.fix).toContain("Desktop-only");
  });

  test("8: broken binary — nonzero exit code", () => {
    const r = checkDevinVersion(
      pathBin,
      execReturning({ exitCode: 1, stderr: "some internal error" }),
    );
    expect(r.pass).toBe(false);
    expect(r.severity).toBeUndefined();
    expect(r.binaryPath).toBe("/usr/local/bin/devin");
    expect(r.label).toContain("exited with code 1");
    // Stderr must NOT be exposed in the label (may contain secrets).
    expect(r.label).not.toContain("internal error");
  });

  test("9: malformed version output (exit 0 but no parseable triple)", () => {
    const r = checkDevinVersion(
      pathBin,
      execReturning({ stdout: "Devin CLI ready\n" }),
    );
    expect(r.pass).toBe(false);
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("unparseable");
  });

  test("10: exact shared floor", () => {
    const r = checkDevinVersion(
      pathBin,
      execReturning({ stdout: `devin ${DEVIN_MIN_VERSION_STRING} (99999)\n` }),
    );
    expect(r.pass).toBe(true);
    expect(r.parsedVersion).toEqual(DEVIN_MIN_VERSION);
    expect(r.label).toContain(DEVIN_MIN_VERSION_STRING);
  });

  test("11: unknown version — exit 0, empty stdout", () => {
    const r = checkDevinVersion(pathBin, execReturning({ stdout: "" }));
    expect(r.pass).toBe(false);
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("unparseable");
  });

  test("12: warning despite exit code 0 — stdout has text but no version triple", () => {
    const r = checkDevinVersion(
      pathBin,
      execReturning({ stdout: "Devin CLI version unknown (debug build)\n" }),
    );
    expect(r.pass).toBe(false);
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("unparseable");
  });

  test("13: timeout — binary hangs on --version", () => {
    const r = checkDevinVersion(pathBin, execReturning({ timedOut: true }));
    expect(r.pass).toBe(false);
    expect(r.label).toContain("timed out");
  });

  test("14: Desktop editor found — pass, no severity, discovery-only label", () => {
    const r = checkDevinDesktop(
      () => "C:\\Users\\test\\AppData\\Local\\Programs\\Devin\\Devin.exe",
    );
    expect(r.pass).toBe(true);
    expect(r.severity).toBeUndefined();
    expect(r.appPath).toBe(
      "C:\\Users\\test\\AppData\\Local\\Programs\\Devin\\Devin.exe",
    );
    expect(r.label).toContain("Devin Desktop installation: found");
    expect(r.label).toContain("launch/session execution not verified");
  });

  test("15: Desktop editor absent — warn, CLI-only use remains supported", () => {
    const r = checkDevinDesktop(() => null);
    expect(r.pass).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.appPath).toBeNull();
    expect(r.label).toContain("Devin Desktop installation: not found");
    expect(r.label).toContain("CLI-only use remains supported");
    expect(r.fix).toContain("Install Devin Desktop");
  });

  test("16: Windows candidates use LOCALAPPDATA then ProgramFiles", () => {
    const candidates = devinDesktopAppCandidates(
      "win32",
      { LOCALAPPDATA: "C:\\Local", ProgramFiles: "C:\\Program Files" },
      "C:\\Users\\test",
    );
    expect(candidates).toEqual([
      "C:\\Local\\Programs\\Devin\\Devin.exe",
      "C:\\Program Files\\Devin\\Devin.exe",
    ]);
  });

  test("17: Windows candidates drop absent env vars; PROGRAMFILES is the fallback", () => {
    expect(devinDesktopAppCandidates("win32", {}, "C:\\Users\\test")).toEqual(
      [],
    );
    expect(
      devinDesktopAppCandidates(
        "win32",
        { LOCALAPPDATA: "C:\\Local" },
        "C:\\Users\\test",
      ),
    ).toEqual(["C:\\Local\\Programs\\Devin\\Devin.exe"]);
    expect(
      devinDesktopAppCandidates(
        "win32",
        { PROGRAMFILES: "C:\\PF" },
        "C:\\Users\\test",
      ),
    ).toEqual(["C:\\PF\\Devin\\Devin.exe"]);
  });

  test("18: macOS candidates are the system then user .app bundles", () => {
    expect(devinDesktopAppCandidates("darwin", {}, "/Users/test")).toEqual([
      "/Applications/Devin.app",
      "/Users/test/Applications/Devin.app",
    ]);
  });

  test("19: Linux candidates are the devin-desktop package paths", () => {
    expect(devinDesktopAppCandidates("linux", {}, "/home/test")).toEqual([
      "/usr/bin/devin-desktop",
      "/usr/share/devin-desktop/devin-desktop",
    ]);
  });

  test("20: unknown platforms have no candidates", () => {
    expect(devinDesktopAppCandidates("freebsd", {}, "/home/test")).toEqual([]);
  });

  // Pure function tests

  test("21: parseVersionTriple extracts numeric triple", () => {
    expect(parseVersionTriple("devin 3000.6.14 (18033302)")).toEqual([3000, 6, 14]);
    expect(parseVersionTriple("3000.5.20")).toEqual([3000, 5, 20]);
    expect(parseVersionTriple("no version here")).toBeNull();
    expect(parseVersionTriple("")).toBeNull();
  });

  test("22: compareTriples lexicographic ordering", () => {
    expect(compareTriples(DEVIN_MIN_VERSION, DEVIN_MIN_VERSION)).toBe(0);
    expect(compareTriples([3000, 10, 22], DEVIN_MIN_VERSION)).toBeGreaterThan(0);
    expect(compareTriples([3000, 10, 20], DEVIN_MIN_VERSION)).toBeLessThan(0);
    expect(compareTriples([3000, 11, 0], DEVIN_MIN_VERSION)).toBeGreaterThan(0);
    expect(compareTriples([3000, 9, 99], DEVIN_MIN_VERSION)).toBeLessThan(0);
    expect(compareTriples([3001, 0, 0], DEVIN_MIN_VERSION)).toBeGreaterThan(0);
  });

  test("23: DEVIN_MIN_VERSION is 3000.10.21", () => {
    expect(DEVIN_MIN_VERSION).toEqual([3000, 10, 21]);
    expect(DEVIN_MIN_VERSION_STRING).toBe("3000.10.21");
  });
});
