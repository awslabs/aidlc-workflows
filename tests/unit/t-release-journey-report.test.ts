// covers: file:tests/harness/release-journey.ts
//
// The release journey's one line is the record a maintainer pastes into the
// release-preparation PR. A journey that stops before its checks ran (a Kiro
// CLI update that changed its status bar, a doctor output that no longer
// parses) prints FAIL with the step that stopped it, never PASS, and the
// error still fails the test.
//
// Mechanism: function - runs the journey runner with a journey that throws.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReleaseJourneyReport, runReleaseJourney } from "../harness/release-journey.ts";

const logDir = mkdtempSync(join(tmpdir(), "aidlc-release-journey-report-"));
const previousLogDir = process.env.AIDLC_TEST_LOG_DIR;
process.env.AIDLC_TEST_LOG_DIR = logDir;

afterAll(() => {
  if (previousLogDir === undefined) delete process.env.AIDLC_TEST_LOG_DIR;
  else process.env.AIDLC_TEST_LOG_DIR = previousLogDir;
  rmSync(logDir, { recursive: true, force: true });
});

describe("t-release-journey-report: the pasted line says FAIL when a journey stops", () => {
  test("a journey that throws before its checks prints FAIL with the step that stopped it", () => {
    const report: ReleaseJourneyReport = { harness: "kiro", toolVersion: "2.29.0", turns: [], extra: {}, problems: [] };
    expect(() => runReleaseJourney(report, () => {
      throw new Error("the status bar never showed aidlc\nscreen follows");
    })).toThrow("the status bar never showed aidlc");
    expect(report.problems).toEqual(["the journey stopped: the status bar never showed aidlc"]);
    const written = JSON.parse(readFileSync(join(logDir, "release-journey-kiro.json"), "utf8")) as { line: string };
    expect(written.line).toContain(": FAIL (");
  });

  test("a journey that finishes with no problems still prints PASS", () => {
    const report: ReleaseJourneyReport = { harness: "copilot", toolVersion: "1.0.96", turns: [{ line: "Approve", seconds: 30 }], extra: {}, problems: [] };
    runReleaseJourney(report, () => {});
    expect(report.problems).toEqual([]);
    const written = JSON.parse(readFileSync(join(logDir, "release-journey-copilot.json"), "utf8")) as { line: string };
    expect(written.line).toContain(": PASS (0.5 min of turns");
  });
});
