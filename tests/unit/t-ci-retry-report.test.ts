// covers: file:scripts/ci-retry-report.ts, file:tests/lib/file-retry.ts
//
// The merge queue reruns an assertion-failed file once. The retry rule decides
// which first attempts earn that second run; the report makes every pass on a
// second attempt visible as a flaky test, and can never fail the job itself.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RetryRecord, retryReport } from "../../scripts/ci-retry-report.ts";
import {
  ISOLATED_RETRY_MAX_MS, ORDINARY_RETRY_MAX_MS, RETRY_DEADLINE_RESERVE_MS, type RetryEvidence, retryEligible,
} from "../lib/file-retry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the retry rule", () => {
  const failed: RetryEvidence = {
    status: "FAIL", cases: { failed: 1 }, evidenceComplete: true, timedOut: false, wallTimeMs: 30_000,
  };

  test("an assertion failure with complete evidence earns one more run", () => {
    expect(retryEligible(failed, ORDINARY_RETRY_MAX_MS)).toBe(true);
  });

  test.each([
    ["a pass", { status: "PASS" as const, cases: { failed: 0 } }],
    ["a skip", { status: "SKIP" as const, cases: { failed: 0 } }],
    ["a nonzero exit without failed cases (crash, empty file)", { cases: { failed: 0 } }],
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

  test("never starts a second attempt the run deadline would cut short", () => {
    expect(retryEligible(failed, ORDINARY_RETRY_MAX_MS, RETRY_DEADLINE_RESERVE_MS + 1)).toBe(true);
    expect(retryEligible(failed, ORDINARY_RETRY_MAX_MS, RETRY_DEADLINE_RESERVE_MS)).toBe(false);
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
      "Retries: 1 file(s) failed on both attempts.",
    ]);
    const table = readFileSync(summary, "utf8");
    expect(table).toContain("### Passed on retry (Windows)");
    expect(table).toContain("| tests/unit/t161-lock.test.ts | 2 | t161-lock.attempt-1.log |");
    expect(table).toContain("### Failed on both attempts (Windows)");
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
