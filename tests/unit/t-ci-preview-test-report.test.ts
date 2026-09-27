// covers: file:scripts/ci-preview-test-report.ts
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectFailures,
  FAILED_SUITE_POINTER,
  FAILED_SUITE_WARNING,
  failedJobs,
  MAX_REPORT,
  parseFailures,
  RELEASE_BODY_LIMIT,
  renderReport,
  type RunFailures,
  stagePreviewNotes,
} from "../../scripts/ci-preview-test-report.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const scratch: string[] = [];
const cli = fileURLToPath(new URL("../../scripts/ci-preview-test-report.ts", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_URL = "https://github.com/owner/repo/actions/runs/42";

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    // Node linear retry delays sum to at most the shared cleanup backstop.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: Math.floor((Math.sqrt(1 + 8 * remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS) / 100) - 1) / 2), retryDelay: 100 });
  }
});

function fixture(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "aidlc-ci-preview-report-"));
  scratch.push(directory);
  return directory;
}

function put(root: string, path: string, content: string): void {
  fs.mkdirSync(dirname(join(root, path)), { recursive: true });
  fs.writeFileSync(join(root, path), content);
}

const OUTER = [
  "FAIL: t333-change-control (2 failed assertions)",
  "  error: expect(received).toContain(expected)",
  "  (fail) t333 (3) precedence > locks the value [418.21ms]",
  "  error: expect(received).toContain(expected)",
  "  (fail) t333 (4) status line > refuses a change [375.03ms]",
  "  (fail) t333 (3) precedence > locks the value [418.21ms]",
  "",
].join("\n");

function report(runs: RunFailures[], overrides: Partial<Parameters<typeof renderReport>[0]> = {}): string {
  return renderReport({
    fullSuiteResult: "failure",
    sourceSha: SHA,
    runUrl: RUN_URL,
    runId: "42",
    legs: { plan: "success", deterministic: "failure" },
    runs,
    jobs: [],
    ...overrides,
  });
}

describe("t-ci-preview-test-report", () => {
  test("failure files yield failing files, deduplicated cases and runner errors", () => {
    const run = parseFailures("deterministic-unit-7-Windows", [
      "error: --filter matched no test files",
      "INCOMPLETE: required selected coverage was not fully exercised",
      "  tests/unit/t1.test.ts: missing; cases=unknown; skipped=unknown",
      OUTER,
      "FAIL: t92",
      "ERROR: isolated e2e did not complete; see e2e-results.json",
    ].join("\r\n"));
    expect(run).toEqual({
      artifact: "deterministic-unit-7-Windows",
      files: [
        {
          name: "t333-change-control",
          reason: "2 failed assertions",
          cases: ["t333 (3) precedence > locks the value", "t333 (4) status line > refuses a change"],
        },
        { name: "t92", reason: "", cases: [] },
      ],
      errors: [
        "error: --filter matched no test files",
        "INCOMPLETE: required selected coverage was not fully exercised",
        "ERROR: isolated e2e did not complete; see e2e-results.json",
      ],
    });
  });

  test("each artifact reports only its own run, never the runner's fixture runs", () => {
    const evidence = fixture();
    // Deterministic layout: the job's stamp pointer names the real run, while
    // runner tests leave deliberately failing stamps beside and below it.
    put(evidence, "full-suite-deterministic-smoke-Linux/tmp/ci-deterministic/stamp.txt",
      "/home/runner/work/repo/repo/tests/logs/2026-09-24T22-02-30Z-p3056\n");
    put(evidence, "full-suite-deterministic-smoke-Linux/tests/logs/2026-09-24T22-02-25Z-p9999/failures.txt",
      "FAIL: fixture-earlier (1 failed assertions)\n");
    put(evidence, "full-suite-deterministic-smoke-Linux/tests/logs/2026-09-24T22-02-30Z-p3056/failures.txt", OUTER);
    put(evidence, "full-suite-deterministic-smoke-Linux/tests/logs/2026-09-24T22-02-30Z-p3056/calibration/logs/" +
      "2026-09-24T22-02-31Z-p4000/failures.txt", "FAIL: nested-fixture (1 failed assertions)\n");
    // An unreadable pointer (Windows backslash damage) falls back to the earliest stamp.
    put(evidence, "full-suite-deterministic-unit-1-Windows/tmp/ci-deterministic/stamp.txt",
      "D:\u0007idlc\tests\\logs\u00826-09-24T21-52-17Z-p6832\n");
    put(evidence, "full-suite-deterministic-unit-1-Windows/tests/logs/2026-09-24T21-52-17Z-p6832/failures.txt",
      "FAIL: t344-swarm-checkpoint-retry (1 failed assertions)\n  (fail) retry > re-enters [9.1ms]\n");
    put(evidence, "full-suite-deterministic-unit-1-Windows/tests/logs/2026-09-24T21-52-40Z-p1840/failures.txt",
      "error: --filter \"NO_SUCH_T05_TEST\" matched no test files\n");
    // Live layout: the uploaded tests/logs directory is the artifact root.
    put(evidence, "full-suite-live-release-contract-1-Linux/2026-09-24T22-53-53Z-p2587/failures.txt",
      "ERROR: Error: isolated e2e interrupted\n");
    put(evidence, "full-suite-deterministic-unit-2-Linux/tests/logs/2026-09-24T22-02-18Z-p3844/failures.txt", "\n");
    put(evidence, "full-suite-result/full-suite-result.json", "{}\n");
    put(evidence, "full-suite-native-plan/native-plan.json", "{}\n");

    expect(collectFailures(evidence)).toEqual([
      {
        artifact: "deterministic-smoke-Linux",
        files: [parseFailures("", OUTER).files[0]],
        errors: [],
      },
      {
        artifact: "deterministic-unit-1-Windows",
        files: [{ name: "t344-swarm-checkpoint-retry", reason: "1 failed assertions", cases: ["retry > re-enters"] }],
        errors: [],
      },
      { artifact: "live-release-contract-1-Linux", files: [], errors: ["ERROR: Error: isolated e2e interrupted"] },
    ]);
    expect(collectFailures(join(evidence, "missing"))).toEqual([]);
  });

  test("only failed Full Suite jobs across every page are listed", () => {
    const job = (id: number, name: string, conclusion: string | null) =>
      ({ id, name, conclusion, html_url: `https://github.com/j/${id}` });
    expect(failedJobs([
      { total_count: 3, jobs: [job(1, "full_suite / live_hosted (codex, 1/5)", "failure"), job(2, "Release tests", null)] },
      { jobs: [job(3, "full_suite / plan", "success"), job(4, "full_suite / Deterministic (windows-latest, e2e) / test", "cancelled")] },
      { jobs: [job(5, "full_suite / live_windows (a)", "skipped"), job(6, "gate", "failure"), job(7, "full_suite / result", "timed_out")] },
      { message: "not a page" },
    ])).toEqual([
      { name: "Deterministic (windows-latest, e2e) / test", url: "https://github.com/j/4" },
      { name: "live_hosted (codex, 1/5)", url: "https://github.com/j/1" },
      { name: "result", url: "https://github.com/j/7" },
    ]);
    expect(failedJobs({ jobs: [] })).toEqual([]);
  });

  test("a passing suite reports one line and a failing one names the evidence", () => {
    expect(report([], { fullSuiteResult: "success" })).toBe(
      `## Nightly test report\n\nFull Suite **passed** for \`0123456789ab\` in [run 42](${RUN_URL}).\n`,
    );
    const runs = [
      parseFailures("deterministic-unit-7-Windows", OUTER),
      parseFailures("deterministic-unit-7-Linux", "FAIL: t333-change-control (1 failed assertions)\n  (fail) t333 (5) new > case [1ms]\n"),
      parseFailures("deterministic-e2e-Windows", "ERROR: isolated e2e did not complete\n"),
    ];
    const text = report(runs, {
      jobs: [
        { name: "Deterministic (windows-latest, unit-7) / test", url: "https://github.com/o/r/actions/runs/42/job/1" },
        { name: "result", url: "" },
      ],
    });
    expect(text).toContain(`Full Suite **failed** for \`0123456789ab\` in [run 42](${RUN_URL}).`);
    expect(text).toContain("Failed legs: `deterministic` (failure).");
    expect(text).toContain([
      "- `t333-change-control` (2 failed assertions; 1 failed assertions) in `deterministic-unit-7-Windows`, `deterministic-unit-7-Linux`",
      "  - `t333 (3) precedence > locks the value`",
      "  - `t333 (4) status line > refuses a change`",
      "  - `t333 (5) new > case`",
    ].join("\n"));
    expect(text).toContain("### Runner errors\n\n- `deterministic-e2e-Windows`: `ERROR: isolated e2e did not complete`");
    expect(text).toContain("- **Deterministic** (1): [Deterministic (windows-latest, unit-7) / test](https://github.com/o/r/actions/runs/42/job/1)");
    expect(text).toContain("- **result** (1): result\n");

    const bare = report([], { legs: undefined, jobs: undefined });
    expect(bare).toContain("The Full Suite result file was not available.");
    expect(bare).toContain("No failing test files were recorded in the downloaded evidence. " +
      "The failed jobs below may have stopped before or outside their tests.");
    expect(bare).toContain("The job list was not available.");
    expect(bare).not.toContain("### Runner errors");
    expect(report([], { legs: { plan: "success" } })).toContain("Failed legs: none recorded.");
  });

  test("names stay inert markup and long reports stay within their budget", () => {
    const hostile = report([parseFailures("unit-1-Linux", [
      "FAIL: t1 (1 failed assertions)",
      "  (fail) pings @org/team with `code` and ``two`` <b>bold</b>\u0007 [2ms]",
    ].join("\n"))], { jobs: [{ name: "live [x] (a)", url: "javascript:alert(1)" }] });
    expect(hostile).toContain("  - ```pings @org/team with `code` and ``two`` <b>bold</b>```");
    expect(hostile).toContain("- **live \\[x\\]** (1): live \\[x\\] (a)\n");
    expect(hostile).not.toContain("javascript:");

    const cases = Array.from({ length: 12 }, (_, index) => `  (fail) case ${index} [1ms]`);
    const many: RunFailures[] = Array.from({ length: 45 }, (_, index) =>
      parseFailures(`unit-${index}`, [`FAIL: t${String(index).padStart(2, "0")} (x)`, ...cases].join("\n")));
    const jobs = Array.from({ length: 7 }, (_, index) => ({ name: `live_hosted (${index})`, url: `https://x/${index}` }));
    const capped = report(many, { jobs });
    expect(capped).toContain("  - `case 7`\n  - ...and 4 more\n");
    expect(capped).not.toContain("`case 8`");
    expect(capped).toContain("- `t39` (x) in `unit-39`");
    expect(capped).not.toContain("`t40`");
    expect(capped).toContain("- ...and 5 more failing files");
    expect(capped).toContain("[live_hosted (4)](https://x/4), ...and 2 more");
    expect(capped.length).toBeLessThanOrEqual(MAX_REPORT);

    const long = "x".repeat(400);
    const huge = report(Array.from({ length: 40 }, (_, index) => parseFailures(`a${index}`, [
      `FAIL: t${index} (${long})`, ...Array.from({ length: 8 }, (_, item) => `  (fail) ${item} ${long} [1ms]`),
    ].join("\n"))));
    expect(huge.length).toBeLessThanOrEqual(MAX_REPORT);
    expect(huge).toEndWith(`\n- ...report truncated; see [run 42](${RUN_URL}).\n`);
    expect(huge).toContain(`${"x".repeat(297)}...`);
  });

  test("published notes keep every planned line and fit GitHub's body limit whenever the plan does", () => {
    expect(RELEASE_BODY_LIMIT).toBe(125_000);
    const body = "- change\n\nSource commit: owner/repo@a\n";
    const report = `## Nightly test report\n\n${Array.from({ length: 200 }, (_, index) => `- \`t${index}\`\n`).join("")}`;
    expect(stagePreviewNotes(body, report)).toBe(`${FAILED_SUITE_WARNING}${body}\n${report}`);
    const exact = `${FAILED_SUITE_WARNING}${body}\n${report}`.length;
    expect(stagePreviewNotes(body, report, exact)).toBe(`${FAILED_SUITE_WARNING}${body}\n${report}`);

    const trimmed = stagePreviewNotes(body, report, exact - 1);
    expect(trimmed.length).toBeLessThan(exact);
    expect(trimmed).toStartWith(`${FAILED_SUITE_WARNING}${body}\n## Nightly test report\n\n- \`t0\`\n`);
    expect(trimmed).toEndWith("`\n- ...report truncated; the run summary has the full report.\n");

    // Near the limit the source footer survives and the body still fits.
    const large = `- ${"x".repeat(124_700)}\n\nSource commit: owner/repo@a\n`;
    const near = stagePreviewNotes(large, report);
    expect(near.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
    expect(near).toStartWith(`${FAILED_SUITE_WARNING}${large}\n`);
    expect(near).toEndWith("\n- ...report truncated; the run summary has the full report.\n");
    // With no room for any report the warning shrinks to a pointer, and a body
    // that fits alone publishes unchanged: a failing suite never adds the overflow.
    const pointed = "x".repeat(RELEASE_BODY_LIMIT - FAILED_SUITE_POINTER.length);
    expect(stagePreviewNotes(pointed, report)).toBe(`${FAILED_SUITE_POINTER}${pointed}`);
    expect(stagePreviewNotes(pointed, report)).toHaveLength(RELEASE_BODY_LIMIT);
    const tight = "x".repeat(RELEASE_BODY_LIMIT - 10);
    expect(stagePreviewNotes(tight, report)).toBe(tight);
    const oversized = "x".repeat(RELEASE_BODY_LIMIT + 1);
    expect(stagePreviewNotes(oversized, report)).toBe(oversized);
  });

  test("the command stages a failing preview's notes in the plan file", () => {
    const root = fixture();
    const plan = {
      schemaVersion: 1, version: "2.10.1-preview.20260925.1", tag: "v2.10.1-preview.20260925.1",
      sourceRepository: "owner/repo", sourceDigest: SHA, previousSourceDigest: null,
      notes: { name: "AI-DLC Workflow 2.10.1-preview.20260925.1", body: `- ${"x".repeat(124_700)}\n\nSource commit: owner/repo@a\n` },
    };
    put(root, "plan.json", `${JSON.stringify(plan)}\n`);
    const report = `## Nightly test report\n\n${"- `t`\n".repeat(200)}`;
    put(root, "report.md", report);
    const staged = Bun.spawnSync([process.execPath, cli, "--stage-notes", join(root, "plan.json"), join(root, "report.md")],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    expect(JSON.parse(fs.readFileSync(join(root, "plan.json"), "utf8")))
      .toEqual({ ...plan, notes: { ...plan.notes, body: stagePreviewNotes(plan.notes.body, report) } });

    const usage = Bun.spawnSync([process.execPath, cli, "--stage-notes", join(root, "plan.json")],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr.toString()).toContain("Usage: bun scripts/ci-preview-test-report.ts --stage-notes");
  });

  test("the command renders the workflow's report from downloaded evidence", () => {
    const root = fixture();
    const evidence = join(root, "evidence");
    put(evidence, "full-suite-result/full-suite-result.json", JSON.stringify({ legs: { deterministic: "failure" } }));
    put(evidence, "full-suite-deterministic-unit-7-Windows/tests/logs/2026-09-24T21-52-16Z-p7036/failures.txt", OUTER);
    put(root, "jobs.json", JSON.stringify([{ jobs: [{ name: "full_suite / result", conclusion: "failure", html_url: "https://x/1" }] }]));
    const env = {
      ...process.env,
      FULL_SUITE_RESULT: "failure",
      SOURCE_SHA: SHA,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "42",
    };
    const output = join(root, "out", "report.md");
    fs.mkdirSync(dirname(output));
    const rendered = Bun.spawnSync([process.execPath, cli, evidence, join(root, "jobs.json"), output], { env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(rendered.exitCode, rendered.stderr.toString()).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe(report([parseFailures("deterministic-unit-7-Windows", OUTER)], {
      legs: { deterministic: "failure" },
      jobs: [{ name: "result", url: "https://x/1" }],
    }));

    const noJobs = Bun.spawnSync([process.execPath, cli, join(root, "absent"), join(root, "absent.json"), output], { env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(noJobs.exitCode, noJobs.stderr.toString()).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toContain("The job list was not available.");

    const usage = Bun.spawnSync([process.execPath, cli, evidence], { env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr.toString()).toContain("Usage: bun scripts/ci-preview-test-report.ts");
  });
});
