// The merge queue reruns an assertion-failed test file once. A file that passed
// only on its second attempt is a flaky test to fix, so this never stays
// silent: a warning annotation per file and a step-summary section, read from
// the runner's retries.json. It always exits 0; the test step decides the job.
//
// `--live <logs-dir>` is the Windows live job's report. The runner prints its
// Flaky and person-turn lines on every OS, but a Windows live job keeps the
// child's output to itself, so the job reads the collected e2e-results.json
// and says the same lines. They are built from fixed words and a test file
// this checkout holds, never from text a test or an agent wrote.
//
//   bun scripts/ci-retry-report.ts <stamp-file>
//   bun scripts/ci-retry-report.ts --live <logs-dir>
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { flakyLiveLine, personTurnLine } from "../tests/lib/file-retry.ts";
import { summaryFromStamp } from "./ci-test-weights.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export interface RetryRecord {
  file: string;
  name: string;
  passedOnRetry: boolean;
  firstAttempt: { failedCases: number; wallTimeMs: number; log: string | null; caseTimeoutsOnly?: boolean };
  secondAttempt: { status: string; failedCases: number; wallTimeMs: number };
}

// Workflow-command data escaping, so a file name cannot end the command.
const escapeData = (text: string): string => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** Annotation lines for stdout; the step summary is appended when GitHub provides one. Never throws. */
export function retryReport(stampFile: string, env = process.env, repoRoot = REPO_ROOT): string[] {
  try {
    const summary = summaryFromStamp(stampFile, join(repoRoot, "tests", "logs"));
    if (!summary) return ["Retries: no run summary to check."];
    const path = join(dirname(summary), "retries.json");
    if (!existsSync(path)) return ["Retries: this run did not allow retries."];
    const { retries } = JSON.parse(readFileSync(path, "utf8")) as { retries: RetryRecord[] };
    if (retries.length === 0) return ["Retries: no test file needed a second attempt."];
    const os = env.RUNNER_OS ?? process.platform;
    const flaky = retries.filter((retry) => retry.passedOnRetry);
    const failed = retries.filter((retry) => !retry.passedOnRetry);
    const lines = flaky.map((retry) =>
      `::warning title=Flaky test::${escapeData(`${retry.file} passed on its second attempt (merge queue)`)}`);
    if (failed.length > 0) lines.push(`Retries: ${failed.length} file(s) still failed after a retry.`);
    if (env.GITHUB_STEP_SUMMARY) {
      const row = (retry: RetryRecord): string =>
        `| ${retry.file} | ${retry.firstAttempt.failedCases} | ${retry.firstAttempt.log ?? "not kept"} |`;
      const section = (heading: string, note: string, rows: RetryRecord[]): string[] => rows.length === 0 ? [] : [
        `### ${heading} (${os})`, "", note, "",
        "| File | Cases failed on the first attempt | First attempt log |", "| --- | --- | --- |",
        ...rows.map(row), "",
      ];
      appendFileSync(env.GITHUB_STEP_SUMMARY, [
        ...section("Passed on retry", "These files failed, then passed when run again: flaky tests to fix. The merge queue let them through; PR CI does not retry.", flaky),
        ...section("Still failed after a retry", "These files failed, and their retry did not pass every case, so the job failed.", failed),
      ].join("\n"));
    }
    return lines;
  } catch (error) {
    return [`Retries: report skipped (${error instanceof Error ? error.message : String(error)}).`];
  }
}

/** A repository test path, as the runner records it; nothing else is said again. */
const TEST_FILE = /^(?:tests\/(?:unit|integration|e2e)|plugins\/[A-Za-z0-9_-]+\/tests)\/[A-Za-z0-9_.-]+\.test\.ts$/;

/** Every e2e-results.json under the collected logs, a few folders deep. */
function liveResults(dir: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) return liveResults(path, depth + 1);
    return entry.isFile() && entry.name === "e2e-results.json" ? [path] : [];
  });
}

/** The Windows live job's Flaky and person-turn lines, from the collected results. Never throws. */
export function liveRetryReport(logsDir: string, repoRoot = REPO_ROOT): string[] {
  let reports: string[];
  try {
    reports = liveResults(logsDir);
  } catch {
    return ["Retries: live report skipped (the collected logs could not be listed)."];
  }
  if (reports.length === 0) return ["Retries: no live results were collected."];
  const lines: string[] = [];
  let unknown = 0;
  let unreadable = 0;
  for (const report of reports) {
    let files: unknown;
    try {
      ({ files } = JSON.parse(readFileSync(report, "utf8")) as { files?: unknown });
    } catch {
      // Fixed words: an error's message can quote the file it could not read.
      unreadable++;
      continue;
    }
    for (const record of Array.isArray(files) ? files : []) {
      const { file, passedOnRetry, personTurnFailure } = (record ?? {}) as Record<string, unknown>;
      if (passedOnRetry !== true && personTurnFailure !== true) continue;
      if (typeof file !== "string" || !TEST_FILE.test(file) || !existsSync(join(repoRoot, file))) {
        unknown++;
        continue;
      }
      if (passedOnRetry === true) lines.push(flakyLiveLine(file));
      if (personTurnFailure === true) lines.push(personTurnLine(file));
    }
  }
  if (unknown > 0) lines.push(`Retries: ${unknown} live result record(s) named no test file of this checkout; not reported.`);
  if (unreadable > 0) lines.push(`Retries: ${unreadable} collected results file(s) could not be read; not reported.`);
  return lines.length > 0 ? lines : ["Retries: no live test file needed a second attempt or failed a person-turn check."];
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === "--live" && second) for (const line of liveRetryReport(second)) console.log(line);
  else if (first && first !== "--live") for (const line of retryReport(first)) console.log(line);
  else console.log("Retries: usage is ci-retry-report.ts <stamp-file> or --live <logs-dir>; report skipped.");
}
