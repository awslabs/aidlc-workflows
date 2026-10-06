// covers: file:scripts/ci-retry-report.ts, file:tests/lib/file-retry.ts
//
// The merge queue reruns an assertion-failed file once. The retry rule decides
// which first attempts earn that second run; the report makes every pass on a
// second attempt visible as a flaky test, and can never fail the job itself.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RetryRecord, retryReport } from "../../scripts/ci-retry-report.ts";
import {
  CASE_TIMEOUT_RETRY_MAX_MS, ISOLATED_RETRY_MAX_MS, ORDINARY_RETRY_MAX_MS, onlyCaseTimeouts, preserveFirstAttempt,
  RETRY_DEADLINE_RESERVE_MS, type RetryEvidence, retryEligible, retryPassed,
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

  // A slow Windows runner times out hook-spawning cases in files that run
  // longer than ten minutes there; such a file still earns its one retry.
  test("a file whose only failures are case timeouts earns its retry up to 25 minutes; any other failure keeps the ten", () => {
    expect(CASE_TIMEOUT_RETRY_MAX_MS).toBe(25 * 60_000);
    const slow = { ...failed, wallTimeMs: 15 * 60_000 };
    expect(retryEligible({ ...slow, caseTimeoutsOnly: true }, ORDINARY_RETRY_MAX_MS)).toBe(true);
    expect(retryEligible({ ...slow, caseTimeoutsOnly: false }, ORDINARY_RETRY_MAX_MS)).toBe(false);
    expect(retryEligible(slow, ORDINARY_RETRY_MAX_MS)).toBe(false);
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, wallTimeMs: CASE_TIMEOUT_RETRY_MAX_MS + 1 }, ORDINARY_RETRY_MAX_MS)).toBe(false);
    // A file that ran past its own deadline is still never retried.
    expect(retryEligible({ ...failed, caseTimeoutsOnly: true, timedOut: true }, ORDINARY_RETRY_MAX_MS)).toBe(false);
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
