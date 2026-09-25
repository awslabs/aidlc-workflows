// Renders the nightly preview's Full Suite report and stages it into the preview
// notes. Preview publication no longer waits for a passing suite, so the run
// summary and the published notes carry the failing jobs and test cases instead.
import fs from "node:fs";
import { basename, join } from "node:path";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-p\d+$/;
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const MAX_FILES = 40;
const MAX_CASES = 8;
const MAX_ERRORS = 20;
const MAX_JOBS_PER_GROUP = 5;
const MAX_TEXT = 300;
// Keeps the run summary readable; stagePreviewNotes budgets the published copy.
export const MAX_REPORT = 30_000;
// GitHub rejects longer release bodies. UTF-16 length never undercounts its characters.
export const RELEASE_BODY_LIMIT = 125_000;
export const FAILED_SUITE_WARNING =
  "> **Warning:** Full Suite failed for this source. A Full Suite failure report ends these notes.\n\n";
export const FAILED_SUITE_POINTER =
  "> **Warning:** Full Suite failed for this source. The preview run has the failure report.\n\n";
const TRUNCATED_NOTES = "\n- ...report truncated; the run summary has the full report.\n";

export interface RunFailures {
  artifact: string;
  files: Array<{ name: string; reason: string; cases: string[] }>;
  errors: string[];
}
export interface FailedJob {
  name: string;
  url: string;
}

function isDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readIfFile(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Tests that drive the runner leave their own fixture stamps (some deliberately
// failing) beside or below the real one, so each artifact reports one run: the
// stamp its job recorded, else the earliest, which the outer runner creates first.
function topLevelStamp(artifactRoot: string): string | undefined {
  const logRoot = isDirectory(join(artifactRoot, "tests", "logs")) ? join(artifactRoot, "tests", "logs") : artifactRoot;
  const stamps = fs.readdirSync(logRoot)
    .filter((name) => STAMP.test(name) && fs.existsSync(join(logRoot, name, "failures.txt")))
    .sort();
  if (stamps.length === 0) return undefined;
  const tmp = join(artifactRoot, "tmp");
  const recorded = isDirectory(tmp)
    ? fs.readdirSync(tmp).map((name) => readIfFile(join(tmp, name, "stamp.txt"))?.trim())
      .filter((value): value is string => !!value)
      .map((value) => basename(value.replaceAll("\\", "/")))
    : [];
  const chosen = stamps.find((name) => recorded.includes(name)) ?? stamps[0];
  return join(logRoot, chosen, "failures.txt");
}

export function parseFailures(artifact: string, text: string): RunFailures {
  const run: RunFailures = { artifact, files: [], errors: [] };
  let current: RunFailures["files"][number] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const failed = /^FAIL: (.+?)(?: \((.*)\))?$/.exec(line);
    if (failed) {
      current = { name: failed[1], reason: failed[2] ?? "", cases: [] };
      run.files.push(current);
      continue;
    }
    const failedCase = /^\s+\(fail\) (.+?)(?: \[[^\]]*\])?$/.exec(line);
    if (failedCase && current) {
      if (!current.cases.includes(failedCase[1])) current.cases.push(failedCase[1]);
      continue;
    }
    if (/^(?:error|ERROR|INCOMPLETE):/.test(line)) run.errors.push(line);
  }
  return run;
}

export function collectFailures(evidenceDir: string): RunFailures[] {
  if (!isDirectory(evidenceDir)) return [];
  return fs.readdirSync(evidenceDir).sort()
    .filter((artifact) => isDirectory(join(evidenceDir, artifact)))
    .flatMap((artifact) => {
      const failures = topLevelStamp(join(evidenceDir, artifact));
      const run = failures ? parseFailures(artifact.replace(/^full-suite-/, ""), readIfFile(failures) ?? "") : undefined;
      return run && (run.files.length > 0 || run.errors.length > 0) ? [run] : [];
    });
}

export function failedJobs(pages: unknown): FailedJob[] {
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => Array.isArray(page?.jobs) ? page.jobs : [])
    .filter((job) => typeof job?.name === "string" && job.name.startsWith("full_suite / ") &&
      FAILED_CONCLUSIONS.has(job.conclusion))
    .map((job) => ({ name: job.name.slice("full_suite / ".length), url: String(job.html_url ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function clean(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: log text may carry terminal controls.
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return plain.length > MAX_TEXT ? `${plain.slice(0, MAX_TEXT - 3)}...` : plain;
}

// Code spans keep test names from rendering as markup or @-mentions.
function code(text: string): string {
  const value = clean(text);
  const fence = "`".repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function label(text: string): string {
  return clean(text).replace(/[\\[\]]/g, "\\$&");
}

function link(text: string, url: string): string {
  return /^https:\/\//.test(url) ? `[${label(text)}](${url})` : label(text);
}

export function renderReport(options: {
  fullSuiteResult: string;
  sourceSha: string;
  runUrl: string;
  runId: string;
  legs: Record<string, string> | undefined;
  runs: RunFailures[];
  jobs: FailedJob[] | undefined;
}): string {
  const source = code(options.sourceSha.slice(0, 12));
  const run = link(`run ${options.runId}`, options.runUrl);
  const lines = ["## Nightly test report", ""];
  if (options.fullSuiteResult === "success") {
    lines.push(`Full Suite **passed** for ${source} in ${run}.`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Full Suite **failed** for ${source} in ${run}. The preview build does not wait for these tests.`, "");
  const legs = Object.entries(options.legs ?? {}).filter(([, status]) => status !== "success");
  lines.push(options.legs
    ? `Failed legs: ${legs.map(([job, status]) => `${code(job)} (${status})`).join(", ") || "none recorded"}.`
    : "The Full Suite result file was not available.");

  const files = new Map<string, { reasons: Set<string>; artifacts: string[]; cases: string[] }>();
  for (const { artifact, files: failed } of options.runs) {
    for (const file of failed) {
      const entry = files.get(file.name) ?? { reasons: new Set<string>(), artifacts: [], cases: [] };
      if (file.reason) entry.reasons.add(file.reason);
      entry.artifacts.push(artifact);
      for (const name of file.cases) if (!entry.cases.includes(name)) entry.cases.push(name);
      files.set(file.name, entry);
    }
  }
  lines.push("", "### Failing tests", "");
  if (files.size === 0) {
    lines.push("No failing test files were recorded in the downloaded evidence. " +
      "The failed jobs below may have stopped before or outside their tests.");
  }
  const names = [...files.keys()].sort((a, b) => a.localeCompare(b, "en"));
  for (const name of names.slice(0, MAX_FILES)) {
    const entry = files.get(name)!;
    const reasons = [...entry.reasons].map(clean).join("; ");
    lines.push(`- ${code(name)}${reasons ? ` (${reasons})` : ""} in ${entry.artifacts.map(code).join(", ")}`);
    for (const test of entry.cases.slice(0, MAX_CASES)) lines.push(`  - ${code(test)}`);
    if (entry.cases.length > MAX_CASES) lines.push(`  - ...and ${entry.cases.length - MAX_CASES} more`);
  }
  if (names.length > MAX_FILES) lines.push(`- ...and ${names.length - MAX_FILES} more failing files`);

  const errors = options.runs.flatMap(({ artifact, errors: found }) => found.map((error) => `${code(artifact)}: ${code(error)}`));
  if (errors.length > 0) {
    lines.push("", "### Runner errors", "");
    for (const error of errors.slice(0, MAX_ERRORS)) lines.push(`- ${error}`);
    if (errors.length > MAX_ERRORS) lines.push(`- ...and ${errors.length - MAX_ERRORS} more`);
  }

  lines.push("", "### Failed jobs", "");
  if (!options.jobs) lines.push("The job list was not available.");
  else if (options.jobs.length === 0) lines.push("No failed Full Suite jobs were listed.");
  const groups = new Map<string, FailedJob[]>();
  for (const job of options.jobs ?? []) {
    const group = job.name.split(" (")[0];
    groups.set(group, [...groups.get(group) ?? [], job]);
  }
  for (const [group, jobs] of groups) {
    const shown = jobs.slice(0, MAX_JOBS_PER_GROUP).map((job) => link(job.name, job.url)).join(", ");
    const more = jobs.length > MAX_JOBS_PER_GROUP ? `, ...and ${jobs.length - MAX_JOBS_PER_GROUP} more` : "";
    lines.push(`- **${label(group)}** (${jobs.length}): ${shown}${more}`);
  }
  lines.push("", `Full logs are in the ${run} ${code("full-suite-*")} artifacts.`);

  let report = `${lines.join("\n")}\n`;
  if (report.length > MAX_REPORT) {
    const note = `\n- ...report truncated; see ${run}.\n`;
    report = `${report.slice(0, report.lastIndexOf("\n", MAX_REPORT - note.length))}${note}`;
  }
  return report;
}

// The published copy keeps every planned line and the source footer. The report,
// then the warning, yields to GitHub's body limit, so a failing suite never stops
// a preview whose planned notes fit.
export function stagePreviewNotes(body: string, report: string, limit = RELEASE_BODY_LIMIT): string {
  const notes = `${FAILED_SUITE_WARNING}${body}`;
  const budget = limit - notes.length - 1;
  if (report.length <= budget) return `${notes}\n${report}`;
  const cut = report.lastIndexOf("\n", budget - TRUNCATED_NOTES.length);
  if (cut > 0) return `${notes}\n${report.slice(0, cut)}${TRUNCATED_NOTES}`;
  const pointed = `${FAILED_SUITE_POINTER}${body}`;
  return pointed.length <= limit ? pointed : body;
}

function readJson(path: string): unknown {
  const text = readIfFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

if (import.meta.main && process.argv[2] === "--stage-notes") {
  const [planPath, reportPath] = process.argv.slice(3);
  if (!planPath || !reportPath || process.argv.length !== 5) {
    console.error("Usage: bun scripts/ci-preview-test-report.ts --stage-notes <plan-json> <report-md>");
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { notes: { body: string } };
  plan.notes.body = stagePreviewNotes(plan.notes.body, fs.readFileSync(reportPath, "utf8"));
  await Bun.write(planPath, `${JSON.stringify(plan)}\n`);
} else if (import.meta.main) {
  const [evidenceDir, jobsPath, outputPath] = process.argv.slice(2);
  if (!evidenceDir || !jobsPath || !outputPath || process.argv.length !== 5) {
    console.error("Usage: bun scripts/ci-preview-test-report.ts <evidence-dir> <jobs-json> <output-md>");
    process.exit(1);
  }
  const result = readJson(join(evidenceDir, "full-suite-result", "full-suite-result.json")) as
    { legs?: Record<string, string> } | undefined;
  const pages = readJson(jobsPath);
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const report = renderReport({
    fullSuiteResult: process.env.FULL_SUITE_RESULT ?? "",
    sourceSha: process.env.SOURCE_SHA ?? "",
    runUrl: `${server}/${process.env.GITHUB_REPOSITORY ?? ""}/actions/runs/${runId}`,
    runId,
    legs: result?.legs,
    runs: collectFailures(evidenceDir),
    jobs: pages === undefined ? undefined : failedJobs(pages),
  });
  await Bun.write(outputPath, report);
}
