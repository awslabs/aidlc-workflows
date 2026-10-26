// covers: file:tests/harness/release-journey.ts
//
// The release journey's one line is the record a maintainer pastes into the
// selected preview's release notes. A journey that stops before its checks ran
// (a Kiro CLI update that changed its status bar, a doctor output that no
// longer parses) prints FAIL with the step that stopped it, never PASS, and
// the error still fails the test. A journey whose agent changes the person's
// files before their pick of a plan starts the work fails at that turn.
//
// Mechanism: function - runs the journey runner with a journey that throws,
// and the turn check on the journey's own project, picked with the engine's
// own `intent create`.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceListing } from "../harness/golden-journey.ts";
import { PersonTurnError } from "../harness/person-turns.ts";
import {
  aidlcCommand, checkReleaseJourneyTurn, expectPersonFirstInJourney, RELEASE_JOURNEY_REQUEST, RELEASE_JOURNEY_TURNS,
  type ReleaseJourneyHarness, type ReleaseJourneyReport, type ReleaseJourneyStart, runReleaseJourney, setupReleaseJourneyProject,
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
  const project = (work: unknown[]): ReleaseJourneyStart => {
    const proj = mkdtempSync(join(logDir, "proj-"));
    mkdirSync(join(proj, "aidlc", "spaces", "default", "intents"), { recursive: true });
    if (work.length) writeFileSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"), JSON.stringify(work));
    return { proj, files: sourceListing(proj), start: 0 };
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

// The person's files stay as they were until their pick of a plan starts the
// work, read by the golden journeys' own check, on Copilot and on both Kiro
// trees. The pick is the engine's `intent create`, which keeps the listing of
// their files at that moment.
describe("t-release-journey-report: the person's files until their pick of a plan starts the work", () => {
  // A Copilot run of 2026-10-23: its first turn, before any plan question, left src/app.js like this.
  const FIXED = `const name = process.argv[2];\nconsole.log(\`Hello, \${name}!\`);\n`;
  const [FIRST, PICK] = RELEASE_JOURNEY_TURNS;
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** The journey's own project, with the records AI-DLC's hooks keep for the first line and its plan question. */
  function journey(harness: ReleaseJourneyHarness): ReturnType<typeof setupReleaseJourneyProject> {
    const project = setupReleaseJourneyProject(harness);
    roots.push(project.root);
    const sessions = join(project.proj, "aidlc", ".aidlc-sessions");
    for (const [dir, record] of [["messages", { at: "2026-10-23T21:28:26Z", text: FIRST }], ["questions", { text: RELEASE_JOURNEY_REQUEST }]] as const) {
      mkdirSync(join(sessions, dir), { recursive: true });
      writeFileSync(join(sessions, dir, "first.json"), JSON.stringify(record));
    }
    return project;
  }

  /** Their "1" starts the work: `intent create` writes WORKFLOW_STARTED with the listing of their files. */
  function pick(project: ReturnType<typeof setupReleaseJourneyProject>): void {
    const made = aidlcCommand(project, ["engine", "intent", "create", "--scope", "bugfix", "--label", "greeter-name"]);
    expect(made.status, made.out.slice(-1500)).toBe(0);
  }

  function problemsAfter(project: ReleaseJourneyStart, turn: number): string[] {
    const run: ReleaseJourneyReport = { harness: "copilot", toolVersion: "1.0.96", turns: [], extra: {}, problems: [] };
    checkReleaseJourneyTurn(run, project, turn, RELEASE_JOURNEY_TURNS[turn - 1]);
    return run.problems;
  }
  const fileLines = (project: ReleaseJourneyStart, turn: number) =>
    problemsAfter(project, turn).filter((problem) => problem.includes("the person's files"));

  test("a first turn that leaves their files as they were passes", () => {
    expect(problemsAfter(journey("copilot"), 1)).toEqual([]);
  });

  test("an edit in the first turn, before the plan question is answered, fails that turn: the kept Copilot run", () => {
    const project = journey("copilot");
    writeFileSync(join(project.proj, "src", "app.js"), FIXED);
    expect(problemsAfter(project, 1)).toEqual([`after "${FIRST}": the person's files changed and no plan was picked: src/app.js`]);
  });

  test("after the pick, an edit made before it is still named, and the work after it is not", () => {
    const project = journey("copilot");
    writeFileSync(join(project.proj, "src", "app.js"), FIXED);
    pick(project);
    writeFileSync(join(project.proj, "src", "name.js"), "module.exports = (name) => name;\n");
    expect(fileLines(project, 2)).toEqual([`after "${PICK}": the person's files changed before their pick started the work: src/app.js`]);
  });

  for (const tree of ["kiro", "kiro-ide"] as const) {
    test(`on the ${tree} tree, the pick itself changes none of their files, and an edit before it is named`, () => {
      const untouched = journey(tree);
      pick(untouched);
      writeFileSync(join(untouched.proj, "src", "app.js"), FIXED);
      expect(fileLines(untouched, 2)).toEqual([]);
      const edited = journey(tree);
      writeFileSync(join(edited.proj, "src", "app.js"), FIXED);
      pick(edited);
      expect(fileLines(edited, 2)).toEqual([`after "${PICK}": the person's files changed before their pick started the work: src/app.js`]);
    });
  }
});
