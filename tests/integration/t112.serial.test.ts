// covers: harness-instrument:runner-exit-equals-failed-files
//
// t112 — "who tests the tester". For a nonempty executed suite, the runner's
// PROCESS EXIT CODE equals the NUMBER OF FAILED TEST FILES. Every tier
// result reported up the chain (CI gates, release gates, the SUMMARY block)
// rests on this number being trustworthy. If aggregation miscounts FAIL rows,
// or a refactor swaps the failed-file count for a plain
// `exit 1` / boolean, the runner would still "look" red on failure but lie
// about the magnitude — and a 0-vs-nonzero regression would silently flip a
// real failure into a green run. This calibrates the instrument itself.
//
// Source contract (tests/run-tests.ts):
//   - runBunTestFile records each file's outcome in a .meta sidecar.
//   - aggregateTierResults counts rows whose status is FAIL.
//   - main returns that count, including the smoke fail-fast path.
// Selection/usage errors can fail without an executed file and are covered by
// the runner option/profile tests; this calibration supplies valid arguments
// and a nonempty planted suite.
//
// TECHNIQUE: invariant. For N in {0,1,2,3} arrange EXACTLY N failing test files
// (plus M passing ones, to prove passes do not perturb the count) and assert the
// runner exits N.
//
// REAL-DRIVE SEAM: run-tests.sh delegates to run-tests.ts, whose SCRIPT_DIR
// resolves from import.meta.url. Copy the runner and its imported helpers into
// a scratch <root>/tests/ and seed <root>/tests/smoke/ with throwaway Bun files.
// The REAL runner aggregates and exits over OUR files only — no real test in
// the repo tree is in scope. Require an executed-case rollup as well as the
// exit code: a bootstrap error also exits 1 but is not one failed test file.
// The --smoke level avoids the integration Claude gate, keeping this calibration
// about runner aggregation only.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { assertRunnerFixtureImports } from "../lib/runner-fixture-imports.ts";
const REAL_RUNNER = join(import.meta.dir, "..", "run-tests.sh");
const REAL_RUNNER_TS = join(import.meta.dir, "..", "run-tests.ts");
const REAL_PROFILE = join(import.meta.dir, "..", "harness", "runner-profile.ts");
const REAL_GLUE = join(import.meta.dir, "..", "lib", "bun-junit-to-meta.ts");
const REAL_SHARDING = join(import.meta.dir, "..", "lib", "test-sharding.ts");
const REAL_PLAN = join(import.meta.dir, "..", "lib", "e2e-plan.ts");
const REAL_REGISTRY = join(import.meta.dir, "..", "gen-coverage-registry.ts");
const REAL_PROCESS = join(import.meta.dir, "..", "lib", "e2e-process.ts");
const REAL_RECORD = join(import.meta.dir, "..", "harness", "tui-record-file.ts");
const REAL_WINDOWS_RECORD = join(import.meta.dir, "..", "harness", "tui-windows-private-file.ts");
const REAL_WORKERS = join(import.meta.dir, "..", "lib", "e2e-workers.ts");
const REAL_RUNTIME = join(import.meta.dir, "..", "harness", "tui-runtime.ts");

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

// A trivially-failing Bun file so the runner's rc-based STATUS derivation
// lands on FAIL.
function failingBunTest(i: number, cases = 1): string {
  const bodies = Array.from({ length: cases }, (_, index) => {
    const label = cases === 1 ? String(i) : `${i}.${index + 1}`;
    return `test("seeded failure ${label}", () => {\n  expect(1).toBe(2);\n});\n`;
  });
  return `import { expect, test } from "bun:test";\n\n${bodies.join("\n")}`;
}

// A trivially-passing Bun file: one green assertion, exit 0 => PASS.
function passingBunTest(j: number): string {
  return `import { expect, test } from "bun:test";\n\ntest("seeded pass ${j}", () => {\n  expect(1).toBe(1);\n});\n`;
}

// Build a scratch <root>/tests with the REAL runner + glue copied in, seed the
// smoke/ level dir with `nFail` failing and `nPass` passing Bun files, then
// drive the real runner against ONLY those files. Smoke remains serial even
// with -P 8. Debug capture retains these deliberately failing child runs beside
// the outer run's evidence; the outer test asserts their expected failure count.
function driveRunner(
  nFail: number,
  nPass: number,
  { nError = 0, nSkip = 0, failuresPerFile = 1 } = {},
): { code: number; stdout: string; summary: string; fileLogs: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "t112-runner-exit-"));
  scratchRoots.push(root);

  const testsDir = join(root, "tests");
  const smokeDir = join(testsDir, "smoke");
  const libDir = join(testsDir, "lib");
  const harnessDir = join(testsDir, "harness");
  mkdirSync(smokeDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });

  copyFileSync(REAL_RUNNER, join(testsDir, "run-tests.sh"));
  copyFileSync(REAL_RUNNER_TS, join(testsDir, "run-tests.ts"));
  copyFileSync(REAL_PROFILE, join(harnessDir, "runner-profile.ts"));
  copyFileSync(REAL_GLUE, join(libDir, "bun-junit-to-meta.ts"));
  copyFileSync(REAL_SHARDING, join(libDir, "test-sharding.ts"));
  copyFileSync(REAL_PLAN, join(libDir, "e2e-plan.ts"));
  copyFileSync(REAL_REGISTRY, join(testsDir, "gen-coverage-registry.ts"));
  copyFileSync(REAL_PROCESS, join(libDir, "e2e-process.ts"));
  copyFileSync(REAL_RECORD, join(harnessDir, "tui-record-file.ts"));
  copyFileSync(REAL_WINDOWS_RECORD, join(harnessDir, "tui-windows-private-file.ts"));
  copyFileSync(REAL_WORKERS, join(libDir, "e2e-workers.ts"));
  copyFileSync(REAL_RUNTIME, join(harnessDir, "tui-runtime.ts"));
  assertRunnerFixtureImports(root);

  // Distinct numeric stems keep glob ordering deterministic and avoid collisions
  // between the fail/pass families.
  for (let i = 1; i <= nFail; i++) {
    writeFileSync(join(smokeDir, `t90${i}-fail.test.ts`), failingBunTest(i, failuresPerFile));
  }
  for (let j = 1; j <= nPass; j++) {
    writeFileSync(join(smokeDir, `t95${j}-pass.test.ts`), passingBunTest(j));
  }
  for (let i = 1; i <= nError; i++) {
    writeFileSync(join(smokeDir, `t96${i}-error.test.ts`), `throw new Error("seeded import error ${i}");\n`);
  }
  for (let i = 1; i <= nSkip; i++) {
    writeFileSync(join(smokeDir, `t97${i}-skip.test.ts`),
      `import { test } from "bun:test";\ntest.skip("seeded skip ${i}", () => { throw new Error("skipped body executed"); });\n`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // These synthetic smoke files need no projections or model calls.
    AIDLC_TEST_PACKAGE_READY: "1",
    AIDLC_NO_LLM: "1",
  };
  delete env.BUN_OPTIONS;
  const res = spawnSync(
    "bash",
    [join(testsDir, "run-tests.sh"), "--debug", "-P", "8", "--smoke"],
    { cwd: root, env, encoding: "utf8", timeout: 30_000 },
  );
  const stdout = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const outerLogDir = process.env.AIDLC_TEST_LOG_DIR;
  if (outerLogDir) {
    const evidence = join(outerLogDir, `calibration-${basename(root)}`);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "run.log"), stdout);
    if (existsSync(join(testsDir, "logs"))) {
      cpSync(join(testsDir, "logs"), join(evidence, "logs"), { recursive: true });
    }
    console.log(`Expected-failure calibration evidence: ${evidence}`);
  }
  expect(res.error, stdout).toBeUndefined();
  const total = nFail + nPass + nError + nSkip;
  expect(stdout).toContain(`\nTest files: ${total}\n`);
  expect(stdout).toContain(`\nExecuted test cases: ${nFail * failuresPerFile + nPass}\n`);
  expect(stdout).toContain(`\nSkipped test cases: ${nSkip}\n`);
  expect(stdout).toContain(`\nFailed files: ${nFail + nError}\n`);
  const stamp = /^Verbose mode: logging to (.+)$/m.exec(stdout)?.[1].trim();
  if (!stamp || !existsSync(join(stamp, "summary.txt"))) {
    throw new Error(`Calibration runner did not produce a summary\n${stdout}`);
  }
  const summary = readFileSync(join(stamp, "summary.txt"), "utf8");
  const fileLogs: Record<string, string> = {};
  for (const [count, prefix, suffix] of [
    [nFail, "t90", "fail"], [nPass, "t95", "pass"],
    [nError, "t96", "error"], [nSkip, "t97", "skip"],
  ] as const) {
    for (let i = 1; i <= count; i++) {
      const key = `${prefix}${i}-${suffix}`;
      fileLogs[key] = readFileSync(join(stamp, `${key}.log`), "utf8");
    }
  }
  // spawnSync sets .status to the exit code, or null if killed by a signal.
  return { code: res.status ?? -1, stdout, summary, fileLogs };
}

describe("run-tests.sh exit code equals number of failed files (harness calibration)", () => {
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

  test("two failing cases in one file still contribute one failed file", () => {
    const { code, summary, fileLogs } = driveRunner(1, 1, { failuresPerFile: 2 });
    expect(code).toBe(1);
    expect(summary).toMatch(/^\s*t901-fail\s+FAIL\s+2\s+2\s/m);
    expect(fileLogs["t901-fail"]).toContain("(fail) seeded failure 1.1");
    expect(fileLogs["t901-fail"]).toContain("(fail) seeded failure 1.2");
  });

  test("import errors count as failed files while skipped cases remain skipped", () => {
    const { code, fileLogs } = driveRunner(1, 2, { nError: 1, nSkip: 1 });
    expect(code).toBe(2);
    expect(fileLogs["t961-error"]).toContain("error: seeded import error 1");
    expect(fileLogs["t971-skip"]).toMatch(/^\s*0 pass\s*$/m);
    expect(fileLogs["t971-skip"]).toMatch(/^\s*1 skip\s*$/m);
    expect(fileLogs["t971-skip"]).not.toContain("error: skipped body executed");
  });

  test("an all-skipped selection exits zero without reporting executed passing cases", () => {
    const { code, fileLogs } = driveRunner(0, 0, { nSkip: 2 });
    expect(code).toBe(0);
    for (const log of Object.values(fileLogs)) {
      expect(log).toMatch(/^\s*0 pass\s*$/m);
      expect(log).toMatch(/^\s*1 skip\s*$/m);
      expect(log).not.toContain("error: skipped body executed");
    }
  });
});
