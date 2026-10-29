// covers: file:tests/harness/release-journey.ts
//
// The release journey's one line is the record a maintainer pastes into the
// selected preview's release notes. A journey that stops before its checks ran
// (a Kiro CLI update that changed its status bar, a doctor output that no
// longer parses) prints FAIL with the step that stopped it, never PASS, and
// the error still fails the test. A journey whose agent changes the person's
// files before their pick of a plan starts the work fails at that turn. A
// turn that had not ended when the journey's time runs out is named as such, and a
// failed journey keeps what AI-DLC recorded and the tool's last screen. Doctor
// after the journey fails it when the hooks never beat, or stopped beating
// while the workflow went on. The line marks a checkout with uncommitted
// changes.
//
// Mechanism: function - runs the journey runner with a journey that throws,
// the turn check on the journey's own project, picked with the engine's own
// `intent create`, and the project's own `doctor --json`.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceListing } from "../harness/golden-journey.ts";
import { PersonTurnError } from "../harness/person-turns.ts";
import {
  aidlcCommand, checkoutIdentity, checkReleaseJourneyTurn, doctorChecks, expectPersonFirstInJourney, hooksRanProblems,
  journeyBudgets, RELEASE_JOURNEY_REQUEST, RELEASE_JOURNEY_TURNS, type ReleaseJourneyHarness, type ReleaseJourneyReport, type ReleaseJourneyStart,
  releaseJourneyEvidence, runReleaseJourney, setupReleaseJourneyProject, waitForTurn,
} from "../harness/release-journey.ts";
import { FILE_CLEANUP_ENV, FILE_DEADLINE_ENV, remainingOperationTimeoutMs, TestBudgetExhaustedError } from "../harness/test-budget.ts";

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

// A Kiro turn that never ends waits on the terminal with the case's work
// budget; once that is spent the wait's budget throws. The turn is then
// unfinished, not the journey stopped, so the report names the line and keeps
// the screen, read with the time the journey keeps back for it.
describe("t-release-journey-report: a turn that has not ended when the journey's time runs out", () => {
  test("a wait stops when its time is gone, and a wait whose work budget runs out leaves the turn unfinished", () => {
    const left = [90_000, 30_000, 0];
    const given: number[] = [];
    expect(waitForTurn((waitMs) => {
      given.push(waitMs);
      return false;
    }, () => left.shift() ?? 0)).toBe(false);
    expect(given).toEqual([90_000, 30_000]);
    // A budget the wait spends that runs out first is the turn not ending, not the journey stopping.
    const deadlineMs = Date.now() + 60_000;
    let polls = 0;
    expect(waitForTurn(() => {
      polls++;
      remainingOperationTimeoutMs(1500, { deadlineMs, reserveMs: 60_000, phase: "E2E live work" });
      return false;
    }, () => 60_000)).toBe(false);
    expect(polls).toBe(1);
  });

  test("the journey's work keeps the last screen's time back on the case deadline and on the runner's file deadline", () => {
    // A 4-minute case keeps 1 minute for cleanup (fileCleanupReserveMs), and the work 2 more for the screen.
    const total = 4 * 60_000;
    const atCase = journeyBudgets(() => Date.now() + 150_000, total, 120_000, {});
    expect(() => atCase.workMs()).toThrow(TestBudgetExhaustedError);
    expect(atCase.screenMs()).toBeGreaterThan(80_000);
    expect(atCase.screenMs()).toBeLessThanOrEqual(90_000);
    // The runner's file deadline comes first: its own reserve, then the screen's time.
    const fileEnv = { [FILE_DEADLINE_ENV]: String(Date.now() + 150_000), [FILE_CLEANUP_ENV]: "60000" };
    const atFile = journeyBudgets(() => Date.now() + 3_600_000, 2 * 3_600_000, 120_000, fileEnv);
    expect(() => atFile.workMs()).toThrow(TestBudgetExhaustedError);
    expect(atFile.screenMs()).toBeGreaterThan(80_000);
    expect(atFile.screenMs()).toBeLessThanOrEqual(90_000);
    // With an hour left (a 5-minute reserve), work runs to the screen's two
    // minutes before the reserve, and the screen gets at most those two
    // minutes, with or without a far file deadline.
    const farFile = { [FILE_DEADLINE_ENV]: String(Date.now() + 7_200_000), [FILE_CLEANUP_ENV]: "300000" };
    for (const env of [{}, farFile]) {
      const roomy = journeyBudgets(() => Date.now() + 3_600_000, 2 * 3_600_000, 120_000, env);
      expect(roomy.workMs()).toBeLessThanOrEqual(3_600_000 - 300_000 - 120_000);
      expect(roomy.workMs()).toBeGreaterThan(3_600_000 - 300_000 - 120_000 - 1_000);
      expect(roomy.screenMs()).toBe(120_000);
    }
    // Both read the runner's file deadline as it is when they are asked, and refuse the same bad value.
    const live: NodeJS.ProcessEnv = {};
    const later = journeyBudgets(() => Date.now() + 3_600_000, 2 * 3_600_000, 120_000, live);
    Object.assign(live, fileEnv);
    expect(() => later.workMs()).toThrow(TestBudgetExhaustedError);
    live[FILE_CLEANUP_ENV] = "1e5";
    expect(() => later.workMs()).toThrow("Invalid test budget");
    expect(() => later.screenMs()).toThrow("Invalid test budget");
  });

  test("a turn that ends, and an error that is not the budget, are left as they are", () => {
    let polls = 0;
    expect(waitForTurn(() => ++polls === 3, () => 60_000)).toBe(true);
    expect(polls).toBe(3);
    expect(() => waitForTurn(() => {
      throw new Error("the terminal session is gone");
    }, () => 60_000)).toThrow("the terminal session is gone");
  });

  test("a failed journey keeps its evidence, also when it threw, and evidence that cannot be read keeps the error", () => {
    const stopped: ReleaseJourneyReport = { harness: "kiro-ide", toolVersion: "2.32.0", turns: [], extra: {}, problems: [] };
    expect(() => runReleaseJourney(stopped, () => {
      throw new Error("Test budget exhausted (E2E live work): case remainingMs=0, reserveMs=300000");
    }, () => ({ screen: "Thinking..." }))).toThrow("Test budget exhausted");
    const written = JSON.parse(readFileSync(join(logDir, "release-journey-kiro-ide.json"), "utf8")) as { extra: { evidence?: unknown } };
    expect(written.extra.evidence).toEqual({ screen: "Thinking..." });

    const unreadable: ReleaseJourneyReport = { harness: "kiro", toolVersion: "2.32.0", turns: [], extra: {}, problems: [] };
    expect(() => runReleaseJourney(unreadable, () => {
      throw new Error("the status bar never showed aidlc");
    }, () => {
      throw new Error("the terminal session is gone");
    })).toThrow("the status bar never showed aidlc");
    expect(unreadable.extra.evidence).toEqual({ unreadable: "the terminal session is gone" });

    // A record the tool was still writing is named, and the rest is kept.
    const proj = mkdtempSync(join(logDir, "half-written-"));
    mkdirSync(join(proj, "aidlc", ".aidlc-sessions", "messages"), { recursive: true });
    writeFileSync(join(proj, "aidlc", ".aidlc-sessions", "messages", "turn.json"), "{\"at\": \"2026-10-28T12:");
    const kept = releaseJourneyEvidence(proj);
    expect(kept.recordedLines).toEqual({ unreadable: expect.stringContaining("JSON") });
    expect(kept.work).toEqual([]);
    expect(kept.audit).toEqual([]);

    const passed: ReleaseJourneyReport = { harness: "kiro", toolVersion: "2.32.0", turns: [], extra: {}, problems: [] };
    runReleaseJourney(passed, () => {}, () => ({ screen: "not kept" }));
    expect(passed.extra.evidence).toBeUndefined();
  });
});

// Doctor after the journey, on the journey's own project once the person's
// pick started the work: hooks that never beat, or stopped beating more than
// doctor's slack before the workflow last advanced, fail the journey.
describe("t-release-journey-report: doctor's hook heartbeat after the journey", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function journeyProject(): ReturnType<typeof setupReleaseJourneyProject> {
    const project = setupReleaseJourneyProject("kiro");
    roots.push(project.root);
    return project;
  }

  test("hooks that never ran fail before and after the pick, a stopped beat fails, and a beat as the workflow advanced passes", () => {
    const project = journeyProject();
    expect(hooksRanProblems(doctorChecks(project))).toEqual(['doctor says "AIDLC hooks have not run in this project yet"']);
    const made = aidlcCommand(project, ["engine", "intent", "create", "--scope", "bugfix", "--label", "greeter-name"]);
    expect(made.status, made.out.slice(-1500)).toBe(0);
    const intents = join(project.proj, "aidlc", "spaces", "default", "intents");
    const health = join(intents, readFileSync(join(intents, "active-intent"), "utf8").trim(), ".aidlc-engine", "hooks-health");
    expect(hooksRanProblems(doctorChecks(project))).toEqual([
      expect.stringMatching(/^doctor says "Hooks have never executed although this workflow has progressed \d+ stages?"$/),
    ]);
    mkdirSync(health, { recursive: true });
    expect(hooksRanProblems(doctorChecks(project))).toEqual(['doctor says "Hook heartbeat data"']);
    writeFileSync(join(health, "write-audit-log.last"), "2000-01-01T00:00:00Z");
    expect(hooksRanProblems(doctorChecks(project))).toEqual([
      expect.stringMatching(/^doctor says "Hooks last fired 2000-01-01T00:00:00Z, but the workflow last advanced /),
    ]);
    writeFileSync(join(health, "write-audit-log.last"), new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(hooksRanProblems(doctorChecks(project))).toEqual([]);
  });
});

// The line names the checkout it ran from. The runner packages dist/ from the
// checkout as it is, so changes not in its HEAD are said.
describe("t-release-journey-report: the line marks a checkout with uncommitted changes", () => {
  test("a clean checkout gives its commit; a tracked edit or a new file adds the mark, an ignored file does not, and a status git cannot read is said", () => {
    const previous = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;
    const repo = mkdtempSync(join(logDir, "checkout-"));
    const git = (...args: string[]): string => {
      const run = spawnSync("git", ["-c", "user.name=Maintainer", "-c", "user.email=maintainer@example.com", ...args], {
        cwd: repo, encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      return run.stdout.trim();
    };
    try {
      git("init", "-q");
      writeFileSync(join(repo, ".gitignore"), "tests/logs/\n");
      writeFileSync(join(repo, "README.md"), "# core\n");
      git("add", ".gitignore", "README.md");
      git("commit", "-qm", "source");
      const head = git("rev-parse", "--short=12", "HEAD");
      mkdirSync(join(repo, "tests", "logs"), { recursive: true });
      writeFileSync(join(repo, "tests", "logs", "run.log"), "log\n");
      expect(checkoutIdentity(repo)).toBe(head);
      writeFileSync(join(repo, "README.md"), "# core, edited\n");
      expect(checkoutIdentity(repo)).toBe(`${head} plus uncommitted changes`);
      git("checkout", "--", "README.md");
      mkdirSync(join(repo, "core"));
      writeFileSync(join(repo, "core", "new.md"), "new\n");
      expect(checkoutIdentity(repo)).toBe(`${head} plus uncommitted changes`);
      // A new file counts whatever the maintainer's own status setting shows.
      git("config", "status.showUntrackedFiles", "no");
      expect(checkoutIdentity(repo)).toBe(`${head} plus uncommitted changes`);
      // A status git cannot read keeps the commit and says so.
      writeFileSync(join(repo, ".git", "index"), "not an index");
      expect(checkoutIdentity(repo)).toBe(`${head} (git status failed)`);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previous;
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
