// covers: harness-instrument:runner-exit-equals-failed-files
//
// t112 — "who tests the tester". The master runner's load-bearing contract is
// that its PROCESS EXIT CODE equals the NUMBER OF FAILED TEST FILES. Every tier
// result reported up the chain (CI gates, release gates, the SUMMARY block)
// rests on this number being trustworthy. If aggregate_tier_results miscounts
// STATUS=FAIL metas, or a refactor swaps `exit "$FAILED_FILES"` for a plain
// `exit 1` / boolean, the runner would still "look" red on failure but lie
// about the magnitude — and a 0-vs-nonzero regression would silently flip a
// real failure into a green run. This calibrates the instrument itself.
//
// Source contract (tests/run-tests.sh):
//   - run_bun_test_file derives STATUS from the child rc: rc!=0 => FAIL.
//   - run_bun_test_file writes a 6-line .meta sidecar per file, incl. STATUS=.
//   - aggregate_tier_results sources each .meta and does
//       if [ "$STATUS" = "FAIL" ]; then FAILED_FILES=$((FAILED_FILES + 1)); fi   (:459-461)
//   - the final line is `exit "$FAILED_FILES"` (:706); the smoke fail-fast path
//     also exits "$FAILED_FILES" (:540).
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
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_RUNNER = join(import.meta.dir, "..", "run-tests.sh");
const REAL_RUNNER_TS = join(import.meta.dir, "..", "run-tests.ts");
const REAL_GLUE = join(import.meta.dir, "..", "lib", "bun-junit-to-meta.ts");
const REAL_SHARDING = join(import.meta.dir, "..", "lib", "test-sharding.ts");

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

// Build a scratch <root>/tests with the REAL runner + glue copied in, seed the
// smoke/ level dir with `nFail` failing and `nPass` passing Bun files, then
// drive the real runner against ONLY those files via --smoke -P 1.
function driveRunner(nFail: number, nPass: number): { code: number; stdout: string } {
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
  copyFileSync(REAL_SHARDING, join(libDir, "test-sharding.ts"));

  // Distinct numeric stems keep glob ordering deterministic and avoid collisions
  // between the fail/pass families.
  for (let i = 1; i <= nFail; i++) {
    writeFileSync(join(smokeDir, `t90${i}-fail.test.ts`), failingBunTest(i));
  }
  for (let j = 1; j <= nPass; j++) {
    writeFileSync(join(smokeDir, `t95${j}-pass.test.ts`), passingBunTest(j));
  }

  const res = spawnSync(
    "bash",
    [join(testsDir, "run-tests.sh"), "--smoke", "-P", "1"],
    { encoding: "utf8" },
  );
  // spawnSync sets .status to the exit code, or null if killed by a signal.
  return { code: res.status ?? -1, stdout: `${res.stdout}\n${res.stderr}` };
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
});
