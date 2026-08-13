// covers: harness-instrument:mechanism-honesty
//
// MR8 meta-test for the all-TS runner cutover. It ties three views together:
// the committed coverage registry, the live body-derived mechanism scan, and
// the runner's Claude skip-set helper.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildRegistry,
  claudeDependenciesOf,
  mechanismsOf,
  type ClaudeDependency,
  type Mechanism,
} from "../gen-coverage-registry.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

interface RegistryClaim {
  file: string;
  mechanism: Mechanism;
}

interface RegistryUnit {
  coveredBy: RegistryClaim[];
}

interface CoverageRegistry {
  units: RegistryUnit[];
}

const TESTS_DIR = join(REPO_ROOT, "tests");
const REGISTRY = join(TESTS_DIR, ".coverage-registry.json");
const RUNNER = join(TESTS_DIR, "run-tests.sh");
const NATIVE_RUNNER = join(TESTS_DIR, "run-tests.ts");
const CLAUDE_GATE = join(TESTS_DIR, "harness", "claude-gate.ts");

function committedMechanismsByFile(): Map<string, Set<Mechanism>> {
  const registry = JSON.parse(
    readFileSync(REGISTRY, "utf-8"),
  ) as CoverageRegistry;
  const out = new Map<string, Set<Mechanism>>();
  for (const unit of registry.units) {
    for (const claim of unit.coveredBy) {
      const set = out.get(claim.file) ?? new Set<Mechanism>();
      set.add(claim.mechanism);
      out.set(claim.file, set);
    }
  }
  return out;
}

function sortedFiles(rows: { file: string }[]): string[] {
  return rows.map((r) => r.file).sort();
}

describe("t134 mechanism honesty and runner Claude gate", () => {
  test("committed registry mechanism matches live mechanismsOf() representative", () => {
    const committed = committedMechanismsByFile();
    const live = new Map<string, Set<Mechanism>>();
    for (const row of buildRegistry().rows) {
      for (const claim of row.coveredBy) {
        const set = live.get(claim.file) ?? new Set<Mechanism>();
        set.add(claim.mechanism);
        live.set(claim.file, set);
      }
    }

    const drift: string[] = [];
    for (const [file, liveMechanisms] of live) {
      const recorded = committed.get(file);
      if (!recorded) {
        drift.push(`${file}: missing from committed registry`);
        continue;
      }
      const liveList = [...liveMechanisms].sort();
      const recordedList = [...recorded].sort();
      if (recordedList.join(",") !== liveList.join(",")) {
        drift.push(
          `${file}: registry=${recordedList.join(",")} live=${liveList.join(",")}`,
        );
      }
    }
    for (const file of committed.keys()) {
      if (!live.has(file)) drift.push(`${file}: committed but not discovered live`);
    }

    expect(drift).toEqual([]);
  });

  test("runner Claude skip-set helper matches the registry-derived live-driver set", () => {
    const expected = sortedFiles(discoverClaudeRequiredTests());
    const result = spawnSync(process.execPath, [CLAUDE_GATE, "--json"], {
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
