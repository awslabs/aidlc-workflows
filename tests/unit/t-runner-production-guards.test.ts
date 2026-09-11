// covers:
// Runner configuration plus real child-runner contracts in isolated fixture trees.
// Child runners use the public shell entrypoint and real Bun JUnit, without packaging.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { RECORDABLE_PROJECT_BYPASSES } from "../../core/tools/aidlc-settings.ts";
import { REPO_ROOT, resetAidlcEnv } from "../harness/fixtures.ts";
import {
  GUARD_PROFILE_ENV,
  parseRunnerArgs,
  PRODUCTION_GUARD_OFF_SWITCHES,
  RunnerArgsError,
  testGuardEnvironment,
} from "../harness/runner-profile.ts";

const FIXTURE_DEFAULTS = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVISION_BACKSTOP: "1",
  AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1",
};

function withProcessEnv(env: NodeJS.ProcessEnv, fn: () => void): void {
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("runner guard profile options", () => {
  test("fixture remains the default regardless of an inherited profile marker", () => {
    const args = parseRunnerArgs([], { [GUARD_PROFILE_ENV]: "production" });
    expect(args.guardProfile).toBe("fixture");
    expect([args.runSmoke, args.runUnit, args.runIntegration, args.runE2e])
      .toEqual([true, true, true, false]);
    expect(args.fullProfile).toBe(false);
  });

  test("production guards compose with a filtered unit shard, debug and no-LLM", () => {
    const args = parseRunnerArgs([
      "--debug", "-P", "8", "--unit", "--production-guards",
      "--filter", "^t-runner-production-guards", "--shard", "1/4", "--no-llm",
    ], {});
    expect(args.guardProfile).toBe("production");
    expect(args.filter).toBe("^t-runner-production-guards");
    expect(args.parallel).toBe(8);
    expect(args.shard).toEqual({ index: 1, total: 4 });
    expect(args.debug && args.verbose && args.noLlm).toBe(true);
    expect([args.runSmoke, args.runUnit, args.runIntegration, args.runE2e])
      .toEqual([false, true, false, false]);
  });

  test("guard selection neither changes default tiers nor enables live-model profiles", () => {
    const args = parseRunnerArgs(["--production-guards"], { AIDLC_NO_LLM: "1" });
    expect(args.guardProfile).toBe("production");
    expect(args.noLlm).toBe(true);
    expect(args.fullProfile).toBe(false);
    expect([args.runSmoke, args.runUnit, args.runIntegration, args.runE2e])
      .toEqual([true, true, true, false]);
    for (const flag of ["--ci", "--release", "--all"]) {
      const selected = parseRunnerArgs(["--production-guards", flag], {});
      expect(selected.guardProfile).toBe("production");
      expect(selected.runE2e).toBe(flag !== "--ci");
    }
  });

  test("a filter value is not interpreted as a guard option; help still exits parsing", () => {
    expect(parseRunnerArgs(["--filter", "--production-guards"], {}).guardProfile)
      .toBe("fixture");
    expect(parseRunnerArgs(["--production-guards", "--help", "--unknown"], {}).help)
      .toBe(true);
  });

  test("invalid arguments retain the existing exit-code contract", () => {
    for (const [argv, exitCode, showUsage] of [
      [["--production-guards=1"], 1, true],
      [["--production-guards", "--parallel", "0"], 2, false],
      [["--production-guards", "--shard", "0/4"], 2, false],
      [["--production-guards", "--ci", "--shard", "1/4"], 2, false],
      [["--filter"], 2, false],
      [["--filter", ""], 2, false],
    ] as const) {
      let caught: unknown;
      try {
        parseRunnerArgs([...argv], {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RunnerArgsError);
      expect((caught as RunnerArgsError).exitCode).toBe(exitCode);
      expect((caught as RunnerArgsError).showUsage).toBe(showUsage);
    }
  });
});

// Copy the runner unchanged, then give it a tiny discovered suite. No planted
// files enter the checkout's test directories, and no model/guard setup runs.
// Keep child logs, stamps and XML for inspection alongside the outer evidence.
function runnerFixture(files: Record<string, string>) {
  const git = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: REPO_ROOT, encoding: "utf8",
  });
  expect(git.status).toBe(0);
  const checkoutRoot = dirname(resolve(REPO_ROOT, git.stdout.trim()));
  const scratch = process.env.TMPDIR || join(checkoutRoot, "tmp", "runner-production-guards");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "runner-fixture-"));
  for (const file of [
    "tests/run-tests.sh",
    "tests/run-tests.ts",
    "tests/harness/runner-profile.ts",
    "tests/lib/bun-junit-to-meta.ts",
    "tests/lib/test-sharding.ts",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(root, file));
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "tests", file)), { recursive: true });
    writeFileSync(join(root, "tests", file), source);
  }
  // This fixture discovery boundary declares one Claude-dependent file; the
  // runner's actual gating, subprocess execution and aggregation remain intact.
  writeFileSync(join(root, "tests/harness/claude-gate.ts"),
    'console.log("tests/integration/t-live.test.ts");\n');
  let runs = 0;
  return {
    root,
    run(argv: string[], overrides: NodeJS.ProcessEnv = {}) {
      const log = join(root, `runner-${++runs}.log`);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...Object.fromEntries(Object.keys(process.env).filter((key) => /_LIVE$/.test(key)).map((key) => [key, "0"])),
        AIDLC_NO_LLM: "0",
        ...overrides,
        AIDLC_TEST_PACKAGE_READY: "1", TMPDIR: root, TMP: root, TEMP: root,
      };
      delete env.BUN_OPTIONS;
      const fd = openSync(log, "w");
      let child: ReturnType<typeof spawnSync>;
      try {
        child = spawnSync("bash", ["tests/run-tests.sh", "--debug", "-P", "8", ...argv], {
          cwd: root, env, stdio: ["ignore", fd, fd], timeout: 30_000,
        });
      } finally {
        closeSync(fd);
      }
      const out = readFileSync(log, "utf8");
      console.log(`Runner command: bash tests/run-tests.sh --debug -P 8 ${argv.map((arg) => JSON.stringify(arg)).join(" ")} (cwd: ${root}; exit: ${child.status})`);
      console.log(`Runner log: ${log}`);
      const stamp = out.match(/^Verbose mode: logging to (.+)$/m)?.[1];
      expect(stamp, out).toBeDefined();
      const summaryPath = join(stamp!, "summary.txt");
      const summary = readFileSync(summaryPath, "utf8");
      const failures = readFileSync(join(stamp!, "failures.txt"), "utf8");
      const traces = readdirSync(stamp!).filter((name) => name.endsWith(".log"));
      const liveVars = argv.includes("--no-llm") || env.AIDLC_NO_LLM === "1"
        ? "none (--no-llm forces gates to 0)"
        : Object.entries(env).filter(([key, value]) => /_LIVE$/.test(key) && value === "1").map(([key]) => key).join(", ") || "none";
      const rows = summary.split("\n").filter((line) => /^ {2}\S+\s+(?:PASS|FAIL|SKIP)\s+\d/.test(line));
      const count = (status: string) => rows.filter((row) => row.includes(` ${status} `)).length;
      const reds = rows.filter((row) => row.includes(" FAIL ")).map((row) => row.trim().split(/\s/)[0]);
      const invariants = failures.split("\n").filter((line) => /^\s*error:.*invariant/i.test(line)).length;
      console.log(`STAMP:    ${stamp}`);
      console.log(`TRACES:   ${stamp}/*.log  (${traces.length} files; JUnit XML retained where Bun emits it)`);
      console.log(`SUMMARY:  ${summaryPath} + failures.txt; ${summary.match(/ {2}Result: .+/)?.[0].trim()}; ${summary.match(/ {2}Failed files: .+/)?.[0].trim()}`);
      console.log(`RESULT:   hermetic runner . ${count("PASS")} pass/${count("FAIL")} fail . reds: ${reds.join(", ") || "none"} . live vars set: ${liveVars} . invariant grep hits: ${invariants} (path-excluded)`);
      expect(child.error, out).toBeUndefined();
      return { status: child.status, out, stamp: stamp!, summary, failures };
    },
  };
}

const PRODUCTION_JOURNEYS = `
import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
const journey = process.env.AIDLC_TEST_GUARD_PROFILE === "production" ? test : test.skip;
describe("production journeys", () => {
  for (const name of ["summary", "recovery"]) {
    journey(name, () => {
      expect(process.env.AIDLC_SKIP_ARTIFACT_GUARD).toBe("0");
      expect(process.env.AIDLC_ALLOW_DIRECT_AUDIT_EVENTS).toBe("0");
      appendFileSync("executed.txt", name + "\\n");
    });
  }
});
`;
const PASSING_CASE = 'import { test } from "bun:test"; test("runs without expect calls", () => {});\n';

describe("explicit runner coverage uses real JUnit execution evidence", () => {
  test("missing --production-guards fails the selected journey file despite a passing sibling", () => {
    const fixture = runnerFixture({
      "unit/t-journeys.test.ts": PRODUCTION_JOURNEYS,
      "unit/t-sibling.test.ts": PASSING_CASE,
    });
    const missing = fixture.run(["--unit", "--no-llm", "--filter", "^t-(journeys|sibling)"]);
    expect(missing.status).toBe(1);
    expect(missing.summary).toContain("Test files: 2");
    expect(missing.summary).toContain("Failed files: 1");
    expect(missing.summary).toContain("Executed test cases: 1");
    expect(missing.summary).toContain("Skipped test cases: 2");
    expect(missing.summary).toContain("Result: FAIL");
    expect(missing.failures).toContain("FAIL: t-journeys");
    expect(missing.failures).toContain("--production-guards");
    expect(missing.out).toContain("=== DONE t-journeys.test.ts (FAIL) ===");
    expect(existsSync(join(fixture.root, "executed.txt"))).toBe(false);
    expect(readFileSync(join(missing.stamp, "t-journeys.junit.xml"), "utf8"))
      .toMatch(/skipped="2"/);

    const proper = fixture.run([
      "--unit", "--no-llm", "--production-guards", "--filter", "^t-(journeys|sibling)",
    ], { AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" });
    expect(proper.status).toBe(0);
    expect(proper.summary).toContain("Test files: 2");
    expect(proper.summary).toContain("Executed test cases: 3");
    expect(proper.summary).toContain("Skipped test cases: 0");
    expect(proper.summary).toContain("Result: PASS");
    expect(proper.failures.trim()).toBe("");
    expect(readFileSync(join(fixture.root, "executed.txt"), "utf8"))
      .toBe("summary\nrecovery\n");
  }, 90_000);

  test("unfiltered fixture suites truthfully skip production journeys", () => {
    const fixture = runnerFixture({
      "unit/t-journeys.test.ts": PRODUCTION_JOURNEYS,
      "unit/t-sibling.test.ts": PASSING_CASE,
    });
    const run = fixture.run(["--unit", "--no-llm"]);
    expect(run.status).toBe(0);
    expect(run.out).toContain("=== DONE t-journeys.test.ts (SKIP) ===");
    expect(run.summary).toContain("Executed test cases: 1");
    expect(run.summary).toContain("Skipped test cases: 2");
    expect(run.summary).toContain("Skipped files: 1");
    expect(run.failures.trim()).toBe("");
    expect(existsSync(join(fixture.root, "executed.txt"))).toBe(false);
  }, 45_000);

  test("partially skipped files pass when a case really executes, without requiring expect calls", () => {
    const fixture = runnerFixture({
      "unit/t-mixed.test.ts": `${PASSING_CASE}test.skip("optional", () => {});\n`,
    });
    const run = fixture.run(["--unit", "--filter", "^t-mixed"]);
    expect(run.status).toBe(0);
    expect(run.summary).toContain("Executed test cases: 1");
    expect(run.summary).toContain("Skipped test cases: 1");
    expect(run.summary).toContain("Result: PASS");
  }, 45_000);

  test("an explicitly selected empty file fails without inventing failed assertions", () => {
    const fixture = runnerFixture({ "unit/t-empty.test.ts": 'import "bun:test";\n' });
    const run = fixture.run(["--unit", "--filter", "^t-empty"]);
    expect(run.status).toBe(1);
    expect(run.summary).toContain("Test files: 1");
    expect(run.summary).toContain("Failed files: 1");
    expect(run.summary).toContain("Failed assertions: 0");
    expect(run.summary).toContain("Executed test cases: 0");
    expect(run.failures).toContain("executed no test cases");
  }, 45_000);

  test("live opt-in alone cannot turn all skipped cases into requested coverage", () => {
    const fixture = runnerFixture({
      "unit/t-live.test.ts": 'import { test } from "bun:test"; test.skip("CLI unavailable", () => {});\n',
    });
    const run = fixture.run(["--unit", "--filter", "^t-live"], { AIDLC_CODEX_EXEC_LIVE: "1" });
    expect(run.status).toBe(1);
    expect(run.summary).toContain("Skipped test cases: 1");
    expect(run.failures).toContain("install/authenticate its CLI");
  }, 45_000);

  test("--no-llm permits mixed deterministic selections but cannot pass a wholly excluded selection", () => {
    const fixture = runnerFixture({
      "integration/t-live.test.ts": 'throw new Error("excluded live file must not launch");\n',
      "integration/t-sibling.test.ts": PASSING_CASE,
    });
    const mixed = fixture.run(["--integration", "--no-llm", "--filter", "^t-(live|sibling)"]);
    expect(mixed.status).toBe(0);
    expect(mixed.out).toContain("=== DONE t-live.test.ts (SKIP) ===");
    expect(mixed.summary).toContain("Executed test cases: 1");
    const excluded = fixture.run(["--integration", "--no-llm", "--filter", "^t-live"]);
    expect(excluded.status).toBe(1);
    expect(excluded.summary).toContain("Test files: 1");
    expect(excluded.summary).toContain("Failed files: 0");
    expect(excluded.summary).toContain("Result: FAIL");
    expect(excluded.failures).toContain("--no-llm excludes Claude-dependent files");
  }, 90_000);

  test("a missing Claude substrate fails a requested file even alongside passing deterministic coverage", () => {
    const fixture = runnerFixture({
      "integration/t-live.test.ts": 'throw new Error("unavailable live file must not launch");\n',
      "integration/t-sibling.test.ts": PASSING_CASE,
    });
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    // Invalid executable on Windows / failing version probe on POSIX. Settings
    // set PATH after the runner prepends its Bun directory, so host CLI installs
    // cannot make this missing-substrate scenario depend on the developer.
    writeFileSync(join(bin, process.platform === "win32" ? "claude.exe" : "claude"),
      "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    mkdirSync(join(fixture.root, ".claude"));
    writeFileSync(join(fixture.root, ".claude", "settings.json"),
      JSON.stringify({ env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } }));
    const run = fixture.run(["--integration", "--filter", "^t-(live|sibling)"]);
    expect(run.status).toBe(1);
    expect(run.summary).toContain("Test files: 2");
    expect(run.summary).toContain("Failed files: 1");
    expect(run.summary).toContain("Executed test cases: 1");
    expect(run.out).not.toContain("=== START t-live.test.ts ===");
    expect(run.failures).toContain("FAIL: t-live");
    expect(run.failures).toContain("Install/authenticate Claude");
  }, 45_000);

  test("an unmatched filter fails with truthful zero-file rollup and a diagnostic", () => {
    const fixture = runnerFixture({ "unit/t-sibling.test.ts": PASSING_CASE });
    const run = fixture.run(["--unit", "--filter", "no-such-file"]);
    expect(run.status).toBe(1);
    expect(run.summary).toContain("Test files: 0");
    expect(run.summary).toContain("Failed files: 0");
    expect(run.summary).toContain("Result: FAIL");
    expect(run.failures).toContain("matched no test files");
    expect(run.out).not.toContain("RESULT: PASS");
  }, 45_000);
});

describe("runner guard child environment", () => {
  test("fixture defaults preserve inherited overrides outside the five historical defaults", () => {
    const inherited = {
      AIDLC_SKIP_ARTIFACT_GUARD: "0",
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
      AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1",
      [GUARD_PROFILE_ENV]: "production",
    };
    const before = { ...inherited };
    expect(testGuardEnvironment(inherited, "fixture")).toEqual({
      ...inherited,
      ...FIXTURE_DEFAULTS,
      [GUARD_PROFILE_ENV]: "fixture",
    });
    expect(inherited).toEqual(before);
  });

  test("production turns off all known bypasses even when the shell omitted them", () => {
    const env = testGuardEnvironment({}, "production");
    expect(env[GUARD_PROFILE_ENV]).toBe("production");
    for (const key of [
      ...Object.keys(FIXTURE_DEFAULTS),
      ...RECORDABLE_PROJECT_BYPASSES,
      "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
      "AIDLC_SKIP_REVIEWER_GATE_GUARD",
      "AIDLC_SKIP_SOURCE_FRESHNESS",
    ]) {
      // Presence matters: deleting a recordable flag allows settings fallback.
      expect(Object.hasOwn(env, key), key).toBe(true);
      expect(env[key], key).toBe("0");
    }
  });

  test("production neutralizes inherited current and future switches without mutating the parent", () => {
    const inherited = {
      ...Object.fromEntries(PRODUCTION_GUARD_OFF_SWITCHES.map((key) => [key, "1"])),
      AIDLC_SKIP_FUTURE_CHECK: "1",
      AIDLC_DISABLE_FUTURE_CHECK: "true",
      AIDLC_ALLOW_DIRECT_FUTURE_EVENTS: "1",
      aidlc_skip_future_check: "1",
      [GUARD_PROFILE_ENV]: "fixture",
      aidlc_test_guard_profile: "fixture",
      PATH: "/runner/bin",
      AWS_PROFILE: "runner-fixture",
      AIDLC_CLAUDE_SDK_LIVE: "0",
      AIDLC_TUI_LIVE: "1",
      AIDLC_TEST_DEBUG: "true",
      AIDLC_TEST_PACKAGE_READY: "1",
    };
    const before = { ...inherited };
    const env = testGuardEnvironment(inherited, "production");
    for (const key of Object.keys(inherited)) {
      if (/^AIDLC_(?:SKIP|DISABLE|ALLOW_DIRECT)_/i.test(key)) {
        expect(env[key], key).toBe("0");
      } else if (key.toUpperCase() !== GUARD_PROFILE_ENV) {
        expect(env[key], key).toBe(inherited[key as keyof typeof inherited]);
      }
    }
    expect(env[GUARD_PROFILE_ENV]).toBe("production");
    expect(env.aidlc_test_guard_profile).toBeUndefined();
    expect(inherited).toEqual(before);
  });

  test("resetAidlcEnv removes source freshness but keeps the profile and other guard zeroes", () => {
    withProcessEnv({
      ...testGuardEnvironment({}, "production"),
      AWS_AIDLC_DEFAULT_SCOPE: "fixture-scope",
    }, () => {
      resetAidlcEnv();
      expect(process.env.AWS_AIDLC_DEFAULT_SCOPE).toBeUndefined();
      expect(process.env.AIDLC_SKIP_SOURCE_FRESHNESS).toBeUndefined();
      expect(process.env[GUARD_PROFILE_ENV]).toBe("production");
      for (const key of PRODUCTION_GUARD_OFF_SWITCHES) {
        if (key !== "AIDLC_SKIP_SOURCE_FRESHNESS") expect(process.env[key], key).toBe("0");
      }
      // The profile is an initial condition, not a lock on test-owned env.
      process.env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
      resetAidlcEnv();
      expect(process.env.AIDLC_SKIP_ARTIFACT_GUARD).toBe("1");
    });
  });

  test("the runner supplies an assertable profile and matching initial child environment", () => {
    const profile = process.env[GUARD_PROFILE_ENV];
    expect(profile).toMatch(/^(fixture|production)$/);
    if (profile === "production") {
      for (const key of PRODUCTION_GUARD_OFF_SWITCHES) {
        expect(process.env[key], key).toBe("0");
      }
      for (const [key, value] of Object.entries(process.env)) {
        if (/^AIDLC_(?:SKIP|DISABLE|ALLOW_DIRECT)_/i.test(key)) {
          expect(value, key).toBe("0");
        }
      }
    } else {
      for (const [key, value] of Object.entries(FIXTURE_DEFAULTS)) {
        expect(process.env[key], key).toBe(value);
      }
    }
  });
});
