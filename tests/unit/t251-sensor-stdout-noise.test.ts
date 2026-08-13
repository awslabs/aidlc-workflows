// covers: tool:aidlc-sensor, tool:aidlc-sensor-linter
//
// t251 - sensor output parsing is robust to leading stdout noise.
//
// Both sensor parse sites JSON.parse a wrapped tool's stdout on exit 0: the
// dispatcher (aidlc-sensor.ts) parses a per-sensor script's result object; the
// linter sensor (aidlc-sensor-linter.ts) parses eslint's `--format json`
// array. When a sensor fires against a sibling repo, that repo's package
// manager (pnpm and friends) can print a run banner or lockfile warning BEFORE
// the JSON, so a bare JSON.parse throws and the real verdict is silently
// discarded as an advisory PASS (dispatcher: script-error: bad-output; linter:
// eslint-bad-output). stripStdoutNoise slices the stdout down to the first
// structural JSON character before parsing, and returns pure-noise input
// unchanged so the existing graceful degradation still fires.
//
// The same normalization is applied to BOTH parse sites: the dispatcher
// (object, startChar `{`) and the linter sensor (array, startChar `[`).
//
// Mechanism: none - a pure in-process exercise of the two exported helpers, no
// spawn, no tool subprocess. The `tool:` covers ids are documentation
// annotations (there is no enumerated "tool" unit class), matching t237's
// convention.

import { describe, expect, test } from "bun:test";
import { stripStdoutNoise as stripDispatcher } from "../../core/tools/aidlc-sensor.ts";
import { stripStdoutNoise as stripLinter } from "../../core/tools/aidlc-sensor-linter.ts";

// A realistic package-manager banner printed before the wrapped tool's JSON.
// Deliberately contains no `{` or `[` so a pure-noise slice finds no structural
// character and returns the input unchanged.
const PM_NOISE = [
  "Scope: all 3 workspace projects",
  "Lockfile is up to date, resolution step is skipped",
  " WARN  deprecated subdependency found in the workspace",
  "",
].join("\n");

describe("t251 dispatcher stdout-noise stripping (result object, startChar '{')", () => {
  test("a result object preceded by package-manager noise parses to the real verdict", () => {
    const verdict = { pass: false, findings_count: 3 };
    const stdout = `${PM_NOISE}${JSON.stringify(verdict)}\n`;
    const parsed = JSON.parse(stripDispatcher(stdout, "{"));
    expect(parsed).toEqual(verdict);
    // The real failing verdict survives, rather than degrading to an advisory PASS.
    expect(parsed.pass).toBe(false);
  });

  test("pure noise (no object) is returned unchanged and still fails to parse", () => {
    const stripped = stripDispatcher(PM_NOISE, "{");
    expect(stripped).toBe(PM_NOISE);
    expect(() => JSON.parse(stripped)).toThrow();
  });

  test("clean JSON is returned byte-for-byte unchanged", () => {
    const clean = `${JSON.stringify({ pass: true })}\n`;
    expect(stripDispatcher(clean, "{")).toBe(clean);
  });
});

describe("t251 linter stdout-noise stripping (eslint array, startChar '[')", () => {
  test("an eslint result array preceded by package-manager noise parses to the real results", () => {
    const results = [
      { filePath: "a.ts", messages: [], errorCount: 0, warningCount: 0 },
    ];
    const stdout = `${PM_NOISE}${JSON.stringify(results)}\n`;
    const parsed = JSON.parse(stripLinter(stdout, "["));
    expect(parsed).toEqual(results);
  });

  test("pure noise (no array) is returned unchanged and still fails to parse", () => {
    const stripped = stripLinter(PM_NOISE, "[");
    expect(stripped).toBe(PM_NOISE);
    expect(() => JSON.parse(stripped)).toThrow();
  });

  test("clean JSON is returned byte-for-byte unchanged", () => {
    const clean = `${JSON.stringify([{ errorCount: 1, messages: [] }])}\n`;
    expect(stripLinter(clean, "[")).toBe(clean);
  });
});
