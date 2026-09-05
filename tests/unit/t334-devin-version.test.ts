// t334-devin-version: unit tests for the Devin CLI version floor check
// (core/tools/aidlc-devin-version.ts).
//
// covers: file:core/tools/aidlc-devin-version.ts
//
// WHAT. The version check discovers the Devin CLI binary (PATH first, then
// cross-platform Desktop paths), executes [binary, "--version"], parses the
// output, and compares against the floor (3000.5.20). These tests verify
// every case in the runbook's S10 matrix using injectable discovery/exec seams:
//   - missing binary (neither PATH nor Desktop)
//   - PATH binary found, version OK
//   - Desktop bundle found (macOS path)
//   - broken preferred binary (nonzero exit)
//   - malformed version output
//   - below floor
//   - exact floor
//   - newer than floor
//   - unknown version (no parseable triple)
//   - warning despite exit code 0 (unparseable but exit 0)
//
// WHY UNIT (not subprocess). The helper's discovery and execution are injectable.
// Tests override them with deterministic stubs — no real binary needed, no
// platform dependency, no timeout flakiness.

import { describe, expect, test } from "bun:test";
import {
  checkDevinVersion,
  compareTriples,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
  type DiscoveryFn,
  type ExecFn,
} from "../../core/tools/aidlc-devin-version.ts";

describe("t334 devin version — checkDevinVersion with injectable seams", () => {
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
  const noDesktop: DiscoveryFn = () => null;
  const pathBin: DiscoveryFn = () => "/usr/local/bin/devin";
  const desktopBin: DiscoveryFn = () =>
    "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin";

  test("1: missing binary — neither PATH nor Desktop found", () => {
    const r = checkDevinVersion(noPath, noDesktop, execReturning({}));
    expect(r.pass).toBe(false);
    expect(r.binaryPath).toBeNull();
    expect(r.source).toBeNull();
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("not found");
    expect(r.fix).toContain(DEVIN_MIN_VERSION_STRING);
  });

  test("2: PATH binary found, version above floor", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "devin 3000.6.14 (18033302)\n" }),
    );
    expect(r.pass).toBe(true);
    expect(r.binaryPath).toBe("/usr/local/bin/devin");
    expect(r.source).toBe("PATH");
    expect(r.parsedVersion).toEqual([3000, 6, 14]);
    expect(r.label).toContain("3000.6.14");
    expect(r.label).toContain(">=");
    expect(r.label).toContain(DEVIN_MIN_VERSION_STRING);
  });

  test("3: Desktop bundle found (macOS path), version above floor", () => {
    const r = checkDevinVersion(
      noPath,
      desktopBin,
      execReturning({ stdout: "devin 3000.6.14 (18033302)\n" }),
    );
    expect(r.pass).toBe(true);
    expect(r.source).toBe("Desktop");
    expect(r.binaryPath).toContain("Devin.app");
    expect(r.label).toContain("(Desktop)");
  });

  test("4: broken preferred binary — nonzero exit code", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ exitCode: 1, stderr: "some internal error" }),
    );
    expect(r.pass).toBe(false);
    expect(r.binaryPath).toBe("/usr/local/bin/devin");
    expect(r.label).toContain("exited with code 1");
    // Stderr must NOT be exposed in the label (may contain secrets).
    expect(r.label).not.toContain("internal error");
  });

  test("5: malformed version output (exit 0 but no parseable triple)", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "Devin CLI ready\n" }),
    );
    expect(r.pass).toBe(false);
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("unparseable");
  });

  test("6: below floor — version 3000.4.0", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "devin 3000.4.0 (12345)\n" }),
    );
    expect(r.pass).toBe(false);
    expect(r.parsedVersion).toEqual([3000, 4, 0]);
    expect(r.label).toContain("3000.4.0");
    expect(r.label).toContain("<");
    expect(r.fix).toContain("upgrade");
  });

  test("7: exact floor — version 3000.5.20", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "devin 3000.5.20 (99999)\n" }),
    );
    expect(r.pass).toBe(true);
    expect(r.parsedVersion).toEqual([3000, 5, 20]);
    expect(r.label).toContain("3000.5.20");
  });

  test("8: newer than floor — version 3000.10.0", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "devin 3000.10.0 (55555)\n" }),
    );
    expect(r.pass).toBe(true);
    expect(r.parsedVersion).toEqual([3000, 10, 0]);
  });

  test("9: unknown version — exit 0, empty stdout", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "" }),
    );
    expect(r.pass).toBe(false);
    expect(r.parsedVersion).toBeNull();
    expect(r.label).toContain("unparseable");
  });

  test("10: warning despite exit code 0 — stdout has text but no version triple", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ stdout: "Devin CLI version unknown (debug build)\n" }),
    );
    expect(r.pass).toBe(false);
    expect(r.exitCode === 0 || r.parsedVersion === null).toBe(true);
    expect(r.label).toContain("unparseable");
  });

  test("11: timeout — binary hangs on --version", () => {
    const r = checkDevinVersion(
      pathBin,
      noDesktop,
      execReturning({ timedOut: true }),
    );
    expect(r.pass).toBe(false);
    expect(r.label).toContain("timed out");
  });

  test("12: PATH takes precedence over Desktop", () => {
    // Both return a path, but PATH should win.
    const r = checkDevinVersion(
      pathBin,
      desktopBin,
      execReturning({ stdout: "devin 3000.6.14 (18033302)\n" }),
    );
    expect(r.source).toBe("PATH");
    expect(r.binaryPath).toBe("/usr/local/bin/devin");
  });

  // Pure function tests

  test("13: parseVersionTriple extracts numeric triple", () => {
    expect(parseVersionTriple("devin 3000.6.14 (18033302)")).toEqual([3000, 6, 14]);
    expect(parseVersionTriple("3000.5.20")).toEqual([3000, 5, 20]);
    expect(parseVersionTriple("no version here")).toBeNull();
    expect(parseVersionTriple("")).toBeNull();
  });

  test("14: compareTriples lexicographic ordering", () => {
    expect(compareTriples([3000, 5, 20], [3000, 5, 20])).toBe(0);
    expect(compareTriples([3000, 5, 21], [3000, 5, 20])).toBeGreaterThan(0);
    expect(compareTriples([3000, 5, 19], [3000, 5, 20])).toBeLessThan(0);
    expect(compareTriples([3000, 6, 0], [3000, 5, 20])).toBeGreaterThan(0);
    expect(compareTriples([3000, 4, 99], [3000, 5, 20])).toBeLessThan(0);
    expect(compareTriples([3001, 0, 0], [3000, 5, 20])).toBeGreaterThan(0);
  });

  test("15: DEVIN_MIN_VERSION is 3000.5.20", () => {
    expect(DEVIN_MIN_VERSION).toEqual([3000, 5, 20]);
    expect(DEVIN_MIN_VERSION_STRING).toBe("3000.5.20");
  });
});
