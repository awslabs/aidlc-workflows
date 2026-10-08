// covers: harness-instrument:mechanism-honesty
//
// MR8 meta-test for the all-TS runner cutover. It ties three views together:
// the coverage registry built fresh, the body-derived mechanism scan, and the
// runner's Claude skip-set helper.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildRegistry,
  claudeDependenciesOf,
  mechanismRank,
  mechanismsOf,
  type ClaudeDependency,
  type Mechanism,
} from "../gen-coverage-registry.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TESTS_DIR = join(REPO_ROOT, "tests");
const RUNNER = join(TESTS_DIR, "run-tests.sh");
const NATIVE_RUNNER = join(TESTS_DIR, "run-tests.ts");
const CLAUDE_GATE = join(TESTS_DIR, "harness", "claude-gate.ts");

function sortedFiles(rows: { file: string }[]): string[] {
  return rows.map((r) => r.file).sort();
}

describe("t134 mechanism honesty and runner Claude gate", () => {
  test("the registry records each claim at the strongest mechanism its body drives", () => {
    const drift: string[] = [];
    for (const row of buildRegistry().rows) {
      for (const claim of row.coveredBy) {
        if (!claim.file.endsWith(".test.ts")) continue;
        const derived = mechanismsOf(basename(claim.file), readFileSync(join(REPO_ROOT, claim.file), "utf-8"));
        const strongest = derived.reduce((best, m) => (mechanismRank(m) >= mechanismRank(best) ? m : best));
        if (claim.mechanism !== strongest) drift.push(`${claim.file}: registry=${claim.mechanism} body=${derived.join(",")}`);
      }
    }
    expect([...new Set(drift)]).toEqual([]);
  });

  test("runner Claude skip-set helper matches the registry-derived live-driver set", () => {
    const expected = sortedFiles(discoverClaudeRequiredTests());
    const result = spawnSync(process.execPath, [CLAUDE_GATE, "--json"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    const actual = sortedFiles(JSON.parse(result.stdout) as { file: string }[]);
    expect(actual).toEqual(expected);

    const nativeRunnerBody = readFileSync(NATIVE_RUNNER, "utf-8");
    expect(nativeRunnerBody).toContain("harness\", \"claude-gate.ts");
    expect(nativeRunnerBody).toContain("shouldSkipForClaude");
    expect(nativeRunnerBody).not.toContain("/t*.sh");

    const wrapperBody = readFileSync(RUNNER, "utf-8");
    expect(wrapperBody).toContain("run-tests.ts");
  });

  test("fixed known-answer table for mechanism and Claude-dependency derivation", () => {
    const cases: Array<{
      file: string;
      mechanisms: Mechanism[];
      claudeDependencies: ClaudeDependency[];
    }> = [
      {
        file: "tests/integration/t19.test.ts",
        mechanisms: ["sdk"],
        claudeDependencies: ["sdk"],
      },
      {
        file: "tests/e2e/t-tui-preflight.serial.test.ts",
        mechanisms: ["tui"],
        claudeDependencies: [],
      },
      {
        file: "tests/e2e/t-tui-kiro-status.serial.test.ts",
        mechanisms: ["tui"],
        claudeDependencies: [],
      },
      {
        file: "tests/unit/t34.test.ts",
        mechanisms: ["cli"],
        claudeDependencies: [],
      },
      {
        file: "tests/integration/t110.test.ts",
        mechanisms: ["none"],
        claudeDependencies: [],
      },
    ];

    for (const c of cases) {
      const abs = join(REPO_ROOT, c.file);
      const src = readFileSync(abs, "utf-8");
      expect(mechanismsOf(basename(c.file), src)).toEqual(c.mechanisms);
      expect(claudeDependenciesOf(basename(c.file), src)).toEqual(
        c.claudeDependencies,
      );
    }
  });
});
