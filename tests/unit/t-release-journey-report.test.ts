// covers: file:tests/harness/release-journey.ts
//
// The release journey's one line is the record a maintainer pastes into the
// selected preview's release notes. A journey that stops before its checks ran
// (a Kiro CLI update that changed its status bar, a doctor output that no
// longer parses) prints FAIL with the step that stopped it, never PASS, and
// the error still fails the test.
//
// Mechanism: function - runs the journey runner with a journey that throws.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonTurnError } from "../harness/person-turns.ts";
import {
  checkReleaseJourneyTurn, expectPersonFirstInJourney, type ReleaseJourneyReport, runReleaseJourney,
} from "../harness/release-journey.ts";

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

  test("the two Kiro trees each print a Kiro CLI line that names the tree, in a report of their own", () => {
    for (const harness of ["kiro", "kiro-ide"] as const) {
      runReleaseJourney({ harness, toolVersion: "2.32.0", turns: [], extra: {}, problems: [] }, () => {});
      const written = JSON.parse(readFileSync(join(logDir, `release-journey-${harness}.json`), "utf8")) as { harness: string; line: string };
      expect(written.harness).toBe(harness);
      expect(written.line).toStartWith(`Kiro CLI 2.32.0 (${harness}) release journey`);
    }
  });
});

// Work started before the person answered is a person-turn failure, which the
// runner never retries. It is read off the journey's record, never off the
// words of a problem, which can quote a tool's output.
describe("t-release-journey-report: running ahead of the person is a person-turn failure", () => {
  const project = (work: unknown[]): string => {
    const proj = mkdtempSync(join(logDir, "proj-"));
    mkdirSync(join(proj, "aidlc", "spaces", "default", "intents"), { recursive: true });
    if (work.length) writeFileSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"), JSON.stringify(work));
    return proj;
  };
  const report = (): ReleaseJourneyReport => ({ harness: "copilot", toolVersion: "1.0.96", turns: [], extra: {}, problems: [] });

  test("work recorded before the plan question's answer fails as a PersonTurnError", () => {
    const run = report();
    checkReleaseJourneyTurn(run, project([{ scope: "bugfix" }]), 1, "/aidlc fix the greeter");
    expect(run.ranAhead).toBe(true);
    expect(run.problems).toContain('after "/aidlc fix the greeter": work was started before the person answered the plan question');
    expect(() => expectPersonFirstInJourney(run)).toThrow(PersonTurnError);
  });

  test("a problem that only quotes those words is an ordinary failure", () => {
    const run = report();
    checkReleaseJourneyTurn(run, project([]), 1, "/aidlc fix the greeter");
    run.problems.push('Copilot ended "1" with exit 1: ... work was started before the person answered the plan question ...');
    expect(run.ranAhead).toBeUndefined();
    expect(() => expectPersonFirstInJourney(run)).not.toThrow();
  });
});
