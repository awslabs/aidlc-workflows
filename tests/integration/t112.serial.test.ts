// covers: harness-instrument:runner-exit-equals-blocking-files
//
// t112 — "who tests the tester". The master runner's load-bearing contract is
// that its PROCESS EXIT CODE equals the NUMBER OF BLOCKING TEST FILES: failures
// plus explicitly requested live files that execute no tests. Every tier
// result reported up the chain (CI gates, release gates, the SUMMARY block)
// rests on this number being trustworthy. If aggregation miscounts FAIL/UNMET
// metas, or a refactor swaps the blocking count for a plain
// `exit 1` / boolean, the runner would still "look" red on failure but lie
// about the magnitude — and a 0-vs-nonzero regression would silently flip a
// real failure into a green run. This calibrates the instrument itself.
//
// Source contract (tests/run-tests.ts):
//   - buildMeta derives PASS/FAIL/SKIP from Bun's JUnit + process rc.
//   - runBunTestFile overlays UNMET when no tests execute for a live gate at `1`.
//   - each file writes one 6-line .meta sidecar carrying that status.
//   - aggregation counts FAIL and UNMET separately, then exits their sum.
//
// TECHNIQUE: invariant. For N in {0,1,2,3} arrange EXACTLY N failing test files
// (plus M passing ones, to prove passes do not perturb the count) and assert the
// runner exits N.
//
// REAL-DRIVE SEAM (chosen over replicating aggregate_tier_results over fixture
// .meta files): SCRIPT_DIR resolves from BASH_SOURCE, and run_tier globs
// "$SCRIPT_DIR/<dir>/*.test.ts". So copying run-tests.sh into a scratch
// <root>/tests/ and seeding <root>/tests/smoke/ with throwaway Bun test files
// makes the REAL runner aggregate and exit over OUR files only — no real test in
// the repo tree is in scope. We copy lib/bun-junit-to-meta.ts too because each
// Bun file is normalized through the same JUnit-to-meta glue as the real suite.
// The --smoke level avoids the integration Claude gate, keeping this calibration
// about runner aggregation only.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMeta } from "../lib/bun-junit-to-meta.ts";

const REAL_RUNNER = join(import.meta.dir, "..", "run-tests.sh");
const REAL_RUNNER_TS = join(import.meta.dir, "..", "run-tests.ts");
const REAL_GLUE = join(import.meta.dir, "..", "lib", "bun-junit-to-meta.ts");

const scratchRoots: string[] = [];

afterEach(() => {
  while (scratchRoots.length) {
    const root = scratchRoots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// A trivially-failing Bun file so run_bun_test_file's rc-based STATUS derivation
// lands on FAIL.
function failingBunTest(i: number): string {
  return `import { expect, test } from "bun:test";\n\ntest("seeded failure ${i}", () => {\n  expect(1).toBe(2);\n});\n`;
}

// A trivially-passing Bun file: one green assertion, exit 0 => PASS.
function passingBunTest(j: number): string {
  return `import { expect, test } from "bun:test";\n\ntest("seeded pass ${j}", () => {\n  expect(1).toBe(1);\n});\n`;
}

function skippedBunTest(requestedLiveGate = false): string {
  const condition = requestedLiveGate
    ? 'process.env.AIDLC_KIRO_IDE_LIVE === "1"'
    : "true";
  return [
    'import { test } from "bun:test";',
    "",
    `test.skipIf(${condition})("seeded skip", () => {`,
    '  throw new Error("skip body must not execute");',
    "});",
    "",
  ].join("\n");
}

function importFailureBunTest(): string {
  return 'throw new Error("seeded import failure");\n';
}

function requestedEmptyBunTest(): string {
  return [
    'import { test } from "bun:test";',
    "",
    'if (process.env.AIDLC_KIRO_IDE_LIVE === "1" && process.env.T112_REGISTER_LIVE_CASE === "1") {',
    '  test("conditionally registered live case", () => {});',
    "}",
    "",
  ].join("\n");
}

interface SeededFile {
  name: string;
  source: string;
}

function driveSeededFiles(
  files: SeededFile[],
  envOverrides: Record<string, string> = {},
  debug = false,
): { code: number; stdout: string; summary: string; failures: string } {
  const root = mkdtempSync(join(tmpdir(), "t112-runner-exit-"));
  scratchRoots.push(root);

  const testsDir = join(root, "tests");
  const smokeDir = join(testsDir, "smoke");
  const libDir = join(testsDir, "lib");
  mkdirSync(smokeDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  copyFileSync(REAL_RUNNER, join(testsDir, "run-tests.sh"));
  copyFileSync(REAL_RUNNER_TS, join(testsDir, "run-tests.ts"));
  copyFileSync(REAL_GLUE, join(libDir, "bun-junit-to-meta.ts"));

  for (const file of files) {
    writeFileSync(join(smokeDir, file.name), file.source);
  }

  const runnerArgs = [join(testsDir, "run-tests.sh"), "--smoke", "-P", "1"];
  if (debug) runnerArgs.push("--debug");
  const res = spawnSync("bash", runnerArgs, {
    encoding: "utf8",
    env: { ...process.env, AIDLC_NO_LLM: "0", ...envOverrides },
  });
  const stdout = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const logDir =
    stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Verbose mode: logging to "))
      ?.slice("Verbose mode: logging to ".length)
      .trim() ?? "";
  const summary =
    logDir && existsSync(join(logDir, "summary.txt"))
      ? readFileSync(join(logDir, "summary.txt"), "utf8")
      : "";
  const failures =
    logDir && existsSync(join(logDir, "failures.txt"))
      ? readFileSync(join(logDir, "failures.txt"), "utf8")
      : "";
  return { code: res.status ?? -1, stdout, summary, failures };
}

// Build a scratch <root>/tests with the REAL runner + glue copied in, seed the
// smoke/ level dir with `nFail` failing and `nPass` passing Bun files, then
// drive the real runner against ONLY those files via --smoke -P 1.
function driveRunner(nFail: number, nPass: number): { code: number; stdout: string } {
  const files: SeededFile[] = [];
  // Distinct numeric stems keep glob ordering deterministic and avoid collisions
  // between the fail/pass families.
  for (let i = 1; i <= nFail; i++) {
    files.push({ name: `t90${i}-fail.test.ts`, source: failingBunTest(i) });
  }
  for (let j = 1; j <= nPass; j++) {
    files.push({ name: `t95${j}-pass.test.ts`, source: passingBunTest(j) });
  }
  return driveSeededFiles(files);
}

const XML_ALL_PASS = `<?xml version="1.0"?>
<testsuites tests="2" failures="0" skipped="0" time="0.002">
  <testsuite tests="2" failures="0" skipped="0">
    <testcase name="pass one" />
    <testcase name="pass two" />
  </testsuite>
</testsuites>`;

const XML_PASS_SKIP = `<?xml version="1.0"?>
<testsuites tests="2" failures="0" skipped="1" time="0.003">
  <testsuite tests="2" failures="0" skipped="1">
    <testcase name="pass" />
    <testcase name="skip"><skipped /></testcase>
  </testsuite>
</testsuites>`;

const XML_ALL_SKIP = `<?xml version="1.0"?>
<testsuites tests="2" failures="0" skipped="2" time="0.004">
  <testsuite tests="2" failures="0" skipped="2">
    <testcase name="skip one"><skipped /></testcase>
    <testcase name="skip two"><skipped /></testcase>
  </testsuite>
</testsuites>`;

describe("JUnit per-file status classification", () => {
  test("all-pass is PASS", () => {
    expect(buildMeta(XML_ALL_PASS, "all-pass", 0)).toMatchObject({
      status: "PASS",
      tests: 2,
      failed: 0,
      rc: 0,
    });
  });

  test("mixed pass/skip is PASS", () => {
    expect(buildMeta(XML_PASS_SKIP, "mixed", 0)).toMatchObject({
      status: "PASS",
      tests: 2,
      failed: 0,
      rc: 0,
    });
  });

  test("all-skip is SKIP", () => {
    expect(buildMeta(XML_ALL_SKIP, "all-skip", 0)).toMatchObject({
      status: "SKIP",
      tests: 2,
      failed: 0,
      rc: 0,
    });
  });

  test("empty suite is PASS", () => {
    expect(buildMeta("", "empty", 0)).toMatchObject({
      status: "PASS",
      tests: 0,
      failed: 0,
      rc: 0,
    });
  });

  test("import failure is FAIL", () => {
    expect(buildMeta("", "import-failure", 1)).toMatchObject({
      status: "FAIL",
      tests: 0,
      failed: 1,
      rc: 1,
    });
  });
});

describe("run-tests.sh exit code equals number of blocking files (harness calibration)", () => {
  // The core invariant: for N failing files, the runner must exit N.
  for (const n of [0, 1, 2, 3]) {
    test(`${n} failing file(s) + 2 passing => exits ${n}`, () => {
      const { code } = driveRunner(n, 2);
      expect(code).toBe(n);
    });
  }

  // 0-failure case spelled out separately: a clean run must exit 0 (green),
  // even with passing files present. This is the half of the contract that a
  // boolean `exit 1`-on-any-failure refactor could keep, while still breaking
  // the magnitude — and that an inverted/always-nonzero bug would break here.
  test("zero failing files exits 0 (green)", () => {
    const { code } = driveRunner(0, 3);
    expect(code).toBe(0);
  });

  // Passing files must NOT inflate the count: many passes + one fail still
  // yields exit 1. Guards against an aggregate that counts FILES instead of
  // STATUS=FAIL metas.
  test("passing files do not perturb the count (5 pass + 1 fail => exits 1)", () => {
    const { code } = driveRunner(1, 5);
    expect(code).toBe(1);
  });

  // The exit code must be the magnitude, not a saturated boolean: 3 failures
  // exits 3, never 1. Pin the SUMMARY block too so the human-readable report
  // and the exit code agree on the count.
  test("exit code is the magnitude, not a boolean (3 fail => exits 3 and SUMMARY agrees)", () => {
    const { code, stdout } = driveRunner(3, 1);
    expect(code).toBe(3);
    expect(stdout).toContain("Failed files: 3");
    expect(stdout).toContain("RESULT: FAIL");
  });
});

describe("all-skipped runner aggregation", () => {
  test("an optional all-skipped file stays SKIP and does not make the tier red", () => {
    const result = driveSeededFiles([
      { name: "t980-optional-skip.test.ts", source: skippedBunTest() },
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--- SKIP: t980-optional-skip.test.ts");
    expect(result.stdout).toContain("=== DONE t980-optional-skip.test.ts (SKIP) ===");
    expect(result.stdout).toContain("Skipped files: 1");
    expect(result.stdout).toContain("Unmet live files: 0");
    expect(result.stdout).toContain("RESULT: PASS");
  });

  test("a requested live all-skipped file is UNMET across console, summaries, and exit", () => {
    const result = driveSeededFiles(
      [{ name: "t981-requested-live-skip.test.ts", source: skippedBunTest(true) }],
      { AIDLC_KIRO_IDE_LIVE: "1" },
      true,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "--- UNMET: t981-requested-live-skip.test.ts (AIDLC_KIRO_IDE_LIVE=1 requested, but no tests executed) ---",
    );
    expect(result.stdout).toContain("=== DONE t981-requested-live-skip.test.ts (UNMET) ===");
    expect(result.stdout).toContain("Failed files: 0");
    expect(result.stdout).toContain("Skipped files: 0");
    expect(result.stdout).toContain("Unmet live files: 1");
    expect(result.stdout).toContain("RESULT: FAIL");
    expect(result.summary).toContain("t981-requested-live-skip");
    expect(result.summary).toContain("UNMET");
    expect(result.summary).toContain("Unmet live files: 1");
    expect(result.summary).toContain("Result: FAIL");
    expect(result.failures).toContain(
      "UNMET: t981-requested-live-skip (requested live gate executed no tests)",
    );
  });

  test("a requested live empty suite is UNMET rather than zero-test PASS", () => {
    const result = driveSeededFiles(
      [{ name: "t982-requested-live-empty.test.ts", source: requestedEmptyBunTest() }],
      { AIDLC_KIRO_IDE_LIVE: "1", T112_REGISTER_LIVE_CASE: "0" },
      true,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "--- UNMET: t982-requested-live-empty.test.ts (AIDLC_KIRO_IDE_LIVE=1 requested, but no tests executed) ---",
    );
    expect(result.stdout).toContain("=== DONE t982-requested-live-empty.test.ts (UNMET) ===");
    expect(result.stdout).toContain("Failed files: 0");
    expect(result.stdout).toContain("Skipped files: 0");
    expect(result.stdout).toContain("Unmet live files: 1");
    expect(result.stdout).toContain("Total assertions: 0");
    expect(result.stdout).toContain("RESULT: FAIL");
    expect(result.summary).toContain("t982-requested-live-empty");
    expect(result.summary).toContain("UNMET");
    expect(result.failures).toContain(
      "UNMET: t982-requested-live-empty (requested live gate executed no tests)",
    );
  });

  test("an import crash remains FAIL rather than empty-suite PASS", () => {
    const result = driveSeededFiles([
      { name: "t983-import-failure.test.ts", source: importFailureBunTest() },
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("--- FAIL: t983-import-failure.test.ts ---");
    expect(result.stdout).toContain("=== DONE t983-import-failure.test.ts (FAIL) ===");
    expect(result.stdout).toContain("Failed files: 1");
    expect(result.stdout).toContain("Unmet live files: 0");
    expect(result.stdout).toContain("RESULT: FAIL");
  });
});
