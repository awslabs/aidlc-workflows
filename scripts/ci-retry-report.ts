// The merge queue reruns an assertion-failed test file once. A file that passed
// only on its second attempt is a flaky test to fix, so this never stays
// silent: a warning annotation per file and a step-summary section, read from
// the runner's retries.json. It always exits 0; the test step decides the job.
//
//   bun scripts/ci-retry-report.ts <stamp-file>
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { summaryFromStamp } from "./ci-test-weights.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export interface RetryRecord {
  file: string;
  name: string;
  passedOnRetry: boolean;
  firstAttempt: { failedCases: number; wallTimeMs: number; log: string | null };
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

if (import.meta.main) {
  const [stampFile] = process.argv.slice(2);
  if (stampFile) for (const line of retryReport(stampFile)) console.log(line);
  else console.log("Retries: usage is ci-retry-report.ts <stamp-file>; report skipped.");
}
