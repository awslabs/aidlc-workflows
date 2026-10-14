// covers: file:scripts/ci-retry-report.ts, file:tests/lib/file-retry.ts
//
// The merge queue reruns an assertion-failed file once. The retry rule decides
// which first attempts earn that second run; the report makes every pass on a
// second attempt visible as a flaky test, and can never fail the job itself.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveRetryReport, type RetryRecord, retryReport } from "../../scripts/ci-retry-report.ts";
import {
  CASE_TIMEOUT_RETRY_MAX_MS, flakyLiveLine, ISOLATED_RETRY_MAX_MS, ORDINARY_RETRY_MAX_MS, onlyCaseTimeouts, personTurnFailed,
  personTurnLine, preserveFirstAttempt, RETRY_DEADLINE_RESERVE_MS, type RetryEvidence, retryEligible, retryPassed,
} from "../lib/file-retry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the retry rule", () => {
  const failed: RetryEvidence = {
    status: "FAIL", cases: { passed: 3, failed: 1, skipped: 1 }, evidenceComplete: true, timedOut: false, wallTimeMs: 30_000,
  };

  test("an assertion failure with complete evidence earns one more run", () => {
    expect(retryEligible(failed, ORDINARY_RETRY_MAX_MS)).toBe(true);
  });

  test.each([
    ["a pass", { status: "PASS" as const, cases: { passed: 4, failed: 0, skipped: 1 } }],
    ["a skip", { status: "SKIP" as const, cases: { passed: 0, failed: 0, skipped: 5 } }],
    ["a nonzero exit without failed cases (crash, empty file)", { cases: { passed: 0, failed: 0, skipped: 0 } }],
    ["incomplete evidence", { evidenceComplete: false }],
    ["missing evidence", { evidenceComplete: undefined }],
    ["a timeout", { timedOut: true }],
    ["a cleanup failure", { cleanupError: "EBUSY" }],
  ])("never retries %s", (_label, change) => {
    expect(retryEligible({ ...failed, ...change }, ORDINARY_RETRY_MAX_MS)).toBe(false);
  });

  test("bounds the first attempt's length: ten minutes for ordinary files, 25 for isolated ones", () => {
    expect(ORDINARY_RETRY_MAX_MS).toBe(10 * 60_000);
    expect(ISOLATED_RETRY_MAX_MS).toBe(25 * 60_000);
    expect(retryEligible({ ...failed, wallTimeMs: ORDINARY_RETRY_MAX_MS }, ORDINARY_RETRY_MAX_MS)).toBe(true);
    expect(retryEligible({ ...failed, wallTimeMs: ORDINARY_RETRY_MAX_MS + 1 }, ORDINARY_RETRY_MAX_MS)).toBe(false);
    expect(retryEligible({ ...failed, wallTimeMs: ORDINARY_RETRY_MAX_MS + 1 }, ISOLATED_RETRY_MAX_MS)).toBe(true);
  });

  // A slow Windows runner times out cases in files that run longer than ten
  // minutes there (one t244 ran 33 minutes); such a file still earns its one retry.
  test("a file whose only failures are case timeouts earns its retry up to 45 minutes; any other failure keeps the ten", () => {
    expect(CASE_TIMEOUT_RETRY_MAX_MS).toBe(45 * 60_000);
    const slow = { ...failed, wallTimeMs: 15 * 60_000 };
    expect(retryEligible({ ...slow, caseTimeoutsOnly: true }, ORDINARY_RETRY_MAX_MS)).toBe(true);
    expect(retryEligible({ ...slow, caseTimeoutsOnly: false }, ORDINARY_RETRY_MAX_MS)).toBe(false);
    expect(retryEligible(slow, ORDINARY_RETRY_MAX_MS)).toBe(false);
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, wallTimeMs: 33 * 60_000 }, ORDINARY_RETRY_MAX_MS)).toBe(true);
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, wallTimeMs: CASE_TIMEOUT_RETRY_MAX_MS + 1 }, ORDINARY_RETRY_MAX_MS)).toBe(false);
    // The five minutes left in the run still bound it.
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, wallTimeMs: 33 * 60_000 }, ORDINARY_RETRY_MAX_MS, 5 * 60_000)).toBe(false);
    // An isolated live file keeps its own 25 minutes.
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, wallTimeMs: ISOLATED_RETRY_MAX_MS + 1 }, ISOLATED_RETRY_MAX_MS)).toBe(false);
    // A file that ran past its own deadline is still never retried.
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, timedOut: true }, ORDINARY_RETRY_MAX_MS)).toBe(false);
  });

  // A live run that saw AI-DLC act for the person (a decision recorded as
  // theirs with no reply of theirs behind it, or work started before they
  // answered) is the break a person would meet; a pass on a second attempt
  // would hide it, so it never earns one.
  test("a person-turn failure never earns a retry, on either path", () => {
    for (const limit of [ORDINARY_RETRY_MAX_MS, ISOLATED_RETRY_MAX_MS]) {
      expect(retryEligible({ ...failed, personTurnFailure: true }, limit)).toBe(false);
      expect(retryEligible({ ...failed, personTurnFailure: false }, limit)).toBe(true);
    }
  });

  test("reads a person-turn failure off bun's JUnit report or the error's own header, as the driver's error writes them", () => {
    const report = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="x">${cases}</testsuite></testsuites>`;
    const personTurn = '<testcase name="a" time="30.0"><failure type="PersonTurnError" message="recorded 1 decision(s)" /></testcase>';
    const assertion = '<testcase name="b" time="0.1"><failure type="AssertionError" message="PersonTurnError in words only" /></testcase>';
    expect(personTurnFailed(report(personTurn + assertion))).toBe(true);
    expect(personTurnFailed(report(assertion))).toBe(false);
    expect(personTurnFailed("")).toBe(false);
    // Bun 1.3 writes every thrown error as a bare AssertionError; the header it
    // prints for the uncaught error says what it was, on LF and CRLF output.
    const bun13 = '<testcase name="a" time="0.1"><failure type="AssertionError" /></testcase>';
    const printed = "15 |     throw new PersonTurnError(\"...\");\r\nPersonTurnError: The SDK drive recorded 1 decision(s)\r\n      at <anonymous> (t-x.test.ts:15:11)\r\n";
    expect(personTurnFailed(report(bun13), printed)).toBe(true);
    expect(personTurnFailed(report(bun13), printed.replaceAll("\r\n", "\n"))).toBe(true);
    // A source excerpt or a sentence that names the error is not its header.
    expect(personTurnFailed(report(bun13), "2 | class PersonTurnError extends Error {}\nerror: expected PersonTurnError: no\n")).toBe(false);
    // The real error, through real bun: the JUnit type and the header both say it.
    const root = mkdtempSync(join(tmpdir(), "aidlc-person-turn-junit-"));
    roots.push(root);
    const harness = join(import.meta.dir, "..", "harness", "person-turns.ts").replaceAll("\\", "/");
    writeFileSync(join(root, "t-x.test.ts"), [
      `import { test } from "bun:test";`,
      `import { unbackedFailure } from ${JSON.stringify(harness)};`,
      `test("an unbacked decision", () => { throw unbackedFailure("The SDK drive", ["GATE_APPROVED at 00:00"]); });`,
    ].join("\n"));
    const junit = join(root, "t-x.junit.xml");
    const child = spawnSync(process.execPath, ["test", "--reporter=junit", `--reporter-outfile=${junit}`, "t-x.test.ts"], {
      cwd: root, encoding: "utf8", timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(1);
    expect(personTurnFailed(readFileSync(junit, "utf8"), `${child.stdout}${child.stderr}`)).toBe(true);
    // The header alone holds on every Bun, whatever its JUnit names the failure.
    expect(personTurnFailed("", `${child.stdout}${child.stderr}`)).toBe(true);
  });

  test("reads case timeouts off bun's JUnit report", () => {
    const report = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="x">${cases}</testsuite></testsuites>`;
    const timeout = '<testcase name="a" time="30.0"><failure type="TimeoutError" message="test timed out" /></testcase>';
    const assertion = '<testcase name="b" time="0.1"><failure type="AssertionError" message="expected 1 to be 2" /></testcase>';
    const passed = '<testcase name="c" time="0.1" />';
    expect(onlyCaseTimeouts(report(timeout + passed))).toBe(true);
    expect(onlyCaseTimeouts(report(timeout + timeout))).toBe(true);
    expect(onlyCaseTimeouts(report(timeout + assertion))).toBe(false);
    expect(onlyCaseTimeouts(report(assertion))).toBe(false);
    expect(onlyCaseTimeouts(report(passed))).toBe(false);
    expect(onlyCaseTimeouts("")).toBe(false);
  });

  test("never starts a second attempt the run deadline would cut short", () => {
    expect(retryEligible(failed, ORDINARY_RETRY_MAX_MS, RETRY_DEADLINE_RESERVE_MS + 1)).toBe(true);
    expect(retryEligible(failed, ORDINARY_RETRY_MAX_MS, RETRY_DEADLINE_RESERVE_MS)).toBe(false);
  });

  const passed: RetryEvidence = { ...failed, status: "PASS", cases: { passed: 4, failed: 0, skipped: 1 } };

  test("a retry replaces the failure when it passes every case the first attempt ran", () => {
    expect(retryPassed(failed, passed)).toBe(true);
  });

  test.each([
    ["skips the failed case while its siblings pass", { cases: { passed: 3, failed: 0, skipped: 2 } }],
    ["runs fewer cases", { cases: { passed: 3, failed: 0, skipped: 1 } }],
    ["fails a case", { status: "FAIL" as const, cases: { passed: 3, failed: 1, skipped: 1 } }],
    ["executes no cases", { status: "SKIP" as const, cases: { passed: 0, failed: 0, skipped: 5 } }],
    ["has incomplete evidence", { evidenceComplete: false }],
    ["times out", { timedOut: true }],
    ["fails its cleanup", { cleanupError: "EBUSY" }],
  ])("a retry that %s leaves the file failed", (_label, change) => {
    expect(retryPassed(failed, { ...passed, ...change })).toBe(false);
  });
});

describe("keeping the first attempt's evidence", () => {
  function logDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-retry-keep-"));
    roots.push(dir);
    for (const file of ["t-x.log", "t-x.junit.xml", "t-x.execution.json"]) writeFileSync(join(dir, file), `first ${file}`);
    mkdirSync(join(dir, "processes", "t-x"), { recursive: true });
    writeFileSync(join(dir, "processes", "t-x", "trace"), "first trace");
    return dir;
  }

  test("moves the log, JUnit, execution record and process artifacts to attempt-1 names", () => {
    const dir = logDir();
    expect(preserveFirstAttempt(dir, "t-x")).toEqual({ ok: true, log: "t-x.attempt-1.log" });
    for (const file of ["t-x.attempt-1.log", "t-x.attempt-1.junit.xml", "t-x.attempt-1.execution.json"]) {
      expect(readFileSync(join(dir, file), "utf8")).toStartWith("first ");
    }
    expect(readFileSync(join(dir, "processes", "t-x.attempt-1", "trace"), "utf8")).toBe("first trace");
    expect(existsSync(join(dir, "t-x.log"))).toBe(false);
  });

  test("refuses, and undoes every move, when any evidence cannot be kept, so the caller does not retry", () => {
    const dir = logDir();
    // An existing attempt-1 target must never be overwritten.
    writeFileSync(join(dir, "t-x.attempt-1.execution.json"), "older evidence");
    expect(preserveFirstAttempt(dir, "t-x")).toEqual({ ok: false, log: null });
    for (const file of ["t-x.log", "t-x.junit.xml", "t-x.execution.json"]) {
      expect(readFileSync(join(dir, file), "utf8")).toBe(`first ${file}`);
    }
    expect(readFileSync(join(dir, "t-x.attempt-1.execution.json"), "utf8")).toBe("older evidence");
    expect(existsSync(join(dir, "t-x.attempt-1.log"))).toBe(false);
  });

  test("a file with no logs at all is kept trivially", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-retry-keep-"));
    roots.push(dir);
    expect(preserveFirstAttempt(dir, "t-none")).toEqual({ ok: true, log: null });
  });
});

describe("the retry report", () => {
  function run(retries: RetryRecord[] | string | undefined): { root: string; stamp: string } {
    const root = mkdtempSync(join(tmpdir(), "aidlc-retry-report-"));
    roots.push(root);
    const logs = join(root, "tests", "logs", "2026-10-03T00-00-00Z-p1");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "summary.txt"), "Totals:\n  Result: PASS\n");
    if (retries !== undefined) {
      writeFileSync(join(logs, "retries.json"), typeof retries === "string" ? retries : JSON.stringify({ retries }));
    }
    // A Windows runner records a drive path; the report finds the stamp under tests/logs.
    writeFileSync(join(root, "stamp.txt"), "D:\\a\\repo\\repo\\tests\\logs\\2026-10-03T00-00-00Z-p1\r\n");
    return { root, stamp: join(root, "stamp.txt") };
  }
  const retry = (file: string, passedOnRetry: boolean): RetryRecord => ({
    file, name: file.split("/").pop()!.replace(/\.test\.ts$/, ""), passedOnRetry,
    firstAttempt: { failedCases: 2, wallTimeMs: 1000, log: `${file.split("/").pop()!.replace(/\.test\.ts$/, "")}.attempt-1.log` },
    secondAttempt: { status: passedOnRetry ? "PASS" : "FAIL", failedCases: passedOnRetry ? 0 : 2, wallTimeMs: 900 },
  });

  test("warns once per file that passed only on its second attempt, and lists both kinds in the step summary", () => {
    const { root, stamp } = run([retry("tests/unit/t161-lock.test.ts", true), retry("tests/integration/t121-stop.test.ts", false)]);
    const summary = join(root, "step-summary.md");
    expect(retryReport(stamp, { RUNNER_OS: "Windows", GITHUB_STEP_SUMMARY: summary }, root)).toEqual([
      "::warning title=Flaky test::tests/unit/t161-lock.test.ts passed on its second attempt (merge queue)",
      "Retries: 1 file(s) still failed after a retry.",
    ]);
    const table = readFileSync(summary, "utf8");
    expect(table).toContain("### Passed on retry (Windows)");
    expect(table).toContain("| tests/unit/t161-lock.test.ts | 2 | t161-lock.attempt-1.log |");
    expect(table).toContain("### Still failed after a retry (Windows)");
    expect(table).toContain("| tests/integration/t121-stop.test.ts | 2 | t121-stop.attempt-1.log |");
  });

  test("says when nothing needed a second attempt, or when retries were off", () => {
    expect(retryReport(run([]).stamp, {}, roots.at(-1)!)).toEqual(["Retries: no test file needed a second attempt."]);
    expect(retryReport(run(undefined).stamp, {}, roots.at(-1)!)).toEqual(["Retries: this run did not allow retries."]);
  });

  test("never throws: a missing stamp or unreadable report only skips it", () => {
    const missing = mkdtempSync(join(tmpdir(), "aidlc-retry-report-"));
    roots.push(missing);
    expect(retryReport(join(missing, "absent.txt"), {}, missing)).toEqual(["Retries: no run summary to check."]);
    const [line] = retryReport(run("{").stamp, {}, roots.at(-1)!);
    expect(line).toStartWith("Retries: report skipped (");
  });

  test("a file name cannot break out of the warning command", () => {
    const [line] = retryReport(run([retry("tests/unit/t-%0A::error::x.test.ts", true)]).stamp, {}, roots.at(-1)!);
    expect(line).toContain("t-%250A::error::x.test.ts");
    expect(line.split("\n")).toHaveLength(1);
  });
});

// A Windows live job keeps the child's output to itself, so its lines never
// become annotations there. The job reads the collected e2e-results.json
// instead and says the same two lines, built only from fixed words and a test
// file this checkout holds: nothing a test or an agent wrote is said again.
describe("the live retry report (Windows)", () => {
  function collected(files: unknown[] | string | undefined, checkout: string[] = []): { root: string; logs: string } {
    const root = mkdtempSync(join(tmpdir(), "aidlc-live-retry-report-"));
    roots.push(root);
    for (const file of checkout) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    const logs = join(root, "tests", "logs");
    const stamp = join(logs, "windows-isolated-0f", "2026-10-14T00-00-00Z-p2");
    mkdirSync(stamp, { recursive: true });
    if (files !== undefined) {
      writeFileSync(join(stamp, "e2e-results.json"), typeof files === "string" ? files : JSON.stringify({ state: "COMPLETE", files }));
    }
    return { root, logs };
  }
  const FLAKY = "tests/e2e/t-exec-codex-compose-inflight.serial.test.ts";
  const PERSON = "tests/e2e/t-exec-copilot-release-journey.serial.test.ts";
  const STEADY = "tests/integration/t20.test.ts";

  test("says the Flaky line and the person-turn line the POSIX jobs print, once per file", () => {
    const { root, logs } = collected([
      { file: FLAKY, state: "PASS", passedOnRetry: true, reason: "::error::from a test" },
      { file: PERSON, state: "FAIL", personTurnFailure: true },
      { file: STEADY, state: "PASS" },
    ], [FLAKY, PERSON, STEADY]);
    expect(liveRetryReport(logs, root)).toEqual([flakyLiveLine(FLAKY), personTurnLine(PERSON)]);
    expect(flakyLiveLine(FLAKY)).toBe("::warning title=Flaky live test::t-exec-codex-compose-inflight.serial.test.ts passed on its second attempt; both attempts are retained.");
    expect(personTurnLine(PERSON)).toStartWith("::error title=Person-turn failure::t-exec-copilot-release-journey.serial.test.ts ");
  });

  test("says nothing about a record that names no test file of this checkout", () => {
    const { root, logs } = collected([
      { file: "tests/e2e/t-%0A::error::x.test.ts", passedOnRetry: true },
      { file: "tests/e2e/../../escape.test.ts", personTurnFailure: true },
      { file: "tests/e2e/t-not-here.test.ts", passedOnRetry: true },
      { file: 7, personTurnFailure: true },
    ]);
    expect(liveRetryReport(logs, root)).toEqual(["Retries: 4 live result record(s) named no test file of this checkout; not reported."]);
  });

  test("says when there is nothing to report, and never throws", () => {
    const quiet = collected([{ file: STEADY, state: "PASS" }], [STEADY]);
    expect(liveRetryReport(quiet.logs, quiet.root)).toEqual(["Retries: no live test file needed a second attempt or failed a person-turn check."]);
    const none = collected(undefined);
    expect(liveRetryReport(none.logs, none.root)).toEqual(["Retries: no live results were collected."]);
    const broken = collected("{");
    expect(liveRetryReport(broken.logs, broken.root)).toEqual(["Retries: 1 collected results file(s) could not be read; not reported."]);
  });

  test("an unreadable results file costs only its own lines", () => {
    const { root, logs } = collected([{ file: FLAKY, state: "PASS", passedOnRetry: true }], [FLAKY]);
    const other = join(logs, "windows-isolated-1a", "2026-10-14T00-00-00Z-p3");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "e2e-results.json"), "{\"files\": [::error::x");
    expect(liveRetryReport(logs, root)).toEqual([
      flakyLiveLine(FLAKY),
      "Retries: 1 collected results file(s) could not be read; not reported.",
    ]);
  });
});
