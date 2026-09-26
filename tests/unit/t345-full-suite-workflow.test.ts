import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyLiveFiles, discoverLiveFiles, FAMILIES, liveFilter, liveMatrix, liveRunnerArgs, liveRunnerCommand, liveRunnerEnvironment, PLATFORM_ONLY, selectedLiveFiles, VERIFICATION_FAMILIES, type LiveFamily, type VerificationFamily } from "../../scripts/ci-live-filter.ts";
import { FULL_SUITE_COVERAGE_POLICY, FULL_SUITE_JOBS, FULL_VERIFICATION_OMITTED_JOBS, LIVE_VERIFICATION_OMITTED_JOBS, fullSuiteResult, type SuiteNeeds, type SuitePurpose } from "../../scripts/ci-full-suite-result.ts";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";
import { brokerChildEnvironment } from "../../scripts/ci-start-credential-broker.ts";
import { sandboxEnvironment } from "../../scripts/ci-live-sandbox.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { setupCodexProject } from "../harness/exec-drive.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { parseShardSpec, selectShard, type ShardConfig } from "../lib/test-sharding.ts";
import { parse } from "smol-toml";

interface Step {
  name?: string;
  id?: string;
  shell?: string;
  "timeout-minutes"?: number | string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Matrix {
  include?: Array<Record<string, string>>;
  exclude?: string;
  family?: LiveFamily[];
  runner?: string[] | string;
  suite?: Array<{ name: string; tier: string; shard?: string }>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  uses?: string;
  "runs-on"?: string | string[];
  "timeout-minutes"?: number | string;
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; "max-parallel"?: number; matrix: Matrix | string };
  steps?: Step[];
  with?: Record<string, string>;
  outputs?: Record<string, string>;
}
const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/full-suite.yml"), "utf8")) as {
  on: {
    workflow_call: { inputs: Record<string, unknown>; secrets?: Record<string, { required: boolean }> };
    workflow_dispatch: { inputs: Record<string, { description?: string; type: string; default?: boolean | string; required?: boolean; options?: string[] }> };
  };
  env: Record<string, string>;
  jobs: Record<string, Job>;
};
const deterministic = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/deterministic-tests.yml"), "utf8")) as {
  on: {
    workflow_call: { inputs: Record<string, { type: string; required?: boolean; default?: string }>; secrets?: unknown; outputs?: unknown };
    workflow_dispatch: { inputs: Record<string, { description?: string; type: string; required?: boolean; default?: string; options?: string[] }> };
  };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

function steps(job: { steps?: Step[] }): Step[] {
  return job.steps ?? [];
}

function aliases(file: string): string[] {
  const parts = file.split("/");
  const name = basename(file, ".test.ts");
  const legacy = parts[0] === "plugins" ? `plugin-${parts[1]}-${name}` : name;
  return [basename(file), legacy, `${parts[0] === "plugins" ? "plugins" : parts[1]}-${legacy}`];
}

function platformOf(runner: string | string[]): string {
  const label = Array.isArray(runner) ? runner.find((part) => part === "Linux" || part === "Windows")! : runner;
  if (/^(ubuntu|Linux)/.test(label)) return "linux";
  if (/^macos/.test(label)) return "darwin";
  if (/^(windows|Windows)/.test(label)) return "win32";
  throw new Error(`unknown runner: ${runner}`);
}

function matrixOf(job: Job): Matrix {
  const matrix = job.strategy?.matrix;
  if (typeof matrix !== "string") return matrix ?? {};
  if (matrix === `\${{ fromJSON(needs.plan.outputs.live_prepare_matrix) }}`) {
    // Preparation fans out by runner, not by family/file. Match the workflow's
    // projection of the real full plan without counting preparation as coverage.
    const planned = [...liveMatrix("hosted").include, ...liveMatrix("windows").include];
    return { runner: [...new Set(planned.map(row => row.runner))] };
  }
  for (const kind of ["hosted", "windows"] as const) {
    if (matrix === `\${{ fromJSON(needs.plan.outputs.live_${kind}_matrix) }}`) {
      return { include: liveMatrix(kind).include.map((row) => ({ ...row })) };
    }
  }
  throw new Error(`Unrecognized live matrix: ${matrix}`);
}

function rows(job: Job): Array<{ family: LiveFamily; platform: string; shard?: string; slice?: string }> {
  const matrix = matrixOf(job);
  if (matrix?.include) return matrix.include.map((row) => {
    const platform = platformOf(row.runner);
    expect(row.platform).toBe(platform);
    return { family: row.family as LiveFamily, platform, shard: row.shard, slice: row.slice };
  });
  return (matrix?.family ?? []).map((family) => ({ family, platform: platformOf(job["runs-on"]!) }));
}

function allSuccess(): SuiteNeeds {
  return Object.fromEntries(FULL_SUITE_JOBS.map((job) => [job, { result: "success" as const }]));
}
function verificationNeeds(family: VerificationFamily = "all"): SuiteNeeds {
  const needs = allSuccess();
  for (const job of LIVE_VERIFICATION_OMITTED_JOBS) needs[job] = { result: "skipped" };
  if (family !== "all") needs.release_contract_windows = { result: "skipped" };
  return needs;
}
function fullVerificationNeeds(): SuiteNeeds {
  const needs = allSuccess();
  for (const job of FULL_VERIFICATION_OMITTED_JOBS) needs[job] = { result: "skipped" };
  return needs;
}
const identity = { sha: "a".repeat(40), runId: "123", runAttempt: "2" };
const excludedFamilies = Object.entries(FAMILIES).filter(([, family]) => family.hosting === "excluded")
  .map(([name]) => name).sort();

describe("t345 complete nightly coverage", () => {
  test("PR and nightly deterministic tiers use one implementation with immutable caller refs", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, Job>;
    };
    const uses = "./.github/workflows/deterministic-tests.yml";
    expect(ci.jobs.deterministic).toMatchObject({
      uses, with: {
        ref: `\${{ github.sha }}`, runner: `\${{ matrix.runner }}`,
        tier: `\${{ matrix.suite.tier }}`, "unit-shard": `\${{ matrix.suite.shard || '' }}`,
        "artifact-label": `ci-deterministic-\${{ matrix.suite.name }}`,
      },
    });
    expect(ci.jobs.deterministic.steps).toBeUndefined();
    expect(ci.jobs.deterministic["runs-on"]).toBeUndefined();
    expect(ci.jobs.deterministic.needs).toBeUndefined();
    expect(ci.jobs.deterministic.strategy?.["fail-fast"]).toBe(false);
    expect(ci.jobs.test.needs).toContain("deterministic");
    expect(workflow.jobs.deterministic).toMatchObject({
      needs: "plan", uses,
      with: {
        ref: `\${{ needs.plan.outputs.sha }}`, runner: `\${{ matrix.runner }}`,
        tier: `\${{ matrix.suite.tier }}`, "unit-shard": `\${{ matrix.suite.shard || '' }}`,
        "artifact-label": `full-suite-deterministic-\${{ matrix.suite.name }}`,
      },
    });
    expect(workflow.jobs.deterministic.steps).toBeUndefined();
    expect(workflow.jobs.deterministic.strategy?.["fail-fast"]).toBe(false);
    const aggregate = steps(ci.jobs.test)[0];
    // The merge queue requires every need; PR-push skips are covered below.
    const results = Object.keys(aggregate.env!).filter((key) => key.endsWith("_RESULT"));
    const passed = { EVENT_NAME: "merge_group", ...Object.fromEntries(results.map((key) => [key, "success"])) };
    const run = (env: Record<string, string>) => spawnSync("bash", ["-e", "-c", aggregate.run!], {
      env: { ...process.env, ...env }, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    }).status;
    expect(run(passed)).toBe(0);
    for (const key of results) {
      for (const status of ["failure", "cancelled", "skipped"]) {
        expect(run({ ...passed, [key]: status }), `${key}=${status}`).toBe(1);
      }
    }
    expect(aggregate.env?.DETERMINISTIC_RESULT).toBe(`\${{ needs.deterministic.result }}`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("shared deterministic setup binds the checkout and prepares each fresh job without credentials", () => {
    expect(Object.keys(deterministic.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(Object.keys(deterministic.on.workflow_call.inputs).sort()).toEqual(["artifact-label", "ref", "runner", "tier", "unit-shard"]);
    expect(deterministic.permissions).toEqual({ contents: "read" });
    const job = deterministic.jobs.test;
    expect(job["runs-on"]).toBe(`\${{ inputs.runner }}`);
    expect(job["timeout-minutes"]).toBe(300);
    const setup = steps(job);
    expect(setup.find((step) => step.name === "Run deterministic tier")?.["timeout-minutes"])
      .toBe(270);
    const checkout = setup.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const bind = setup.findIndex((step) => step.name === "Bind checkout to requested commit");
    const install = setup.findIndex((step) => step.run === "bun install --frozen-lockfile");
    const packageIndex = setup.findIndex((step) => step.run === "bun scripts/package.ts");
    expect(setup[checkout].with).toEqual({ ref: `\${{ inputs.ref }}`, "persist-credentials": false });
    expect(bind).toBeGreaterThan(checkout);
    expect(bind).toBeLessThan(install);
    expect(setup[bind].run).toContain('test "$(git rev-parse HEAD)" = "$TEST_REF"');
    expect(packageIndex).toBeGreaterThan(install);
    expect(packageIndex).toBeLessThan(setup.findIndex((step) => step.name === "Run deterministic tier"));
    expect(setup.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.with?.["bun-version"]).toBe("1.4.2");
    const substrate = setup.find((step) => step.name === "Prepare unit test substrates")!;
    expect(substrate.if).toBe("inputs.tier == 'unit' && runner.os != 'Windows'");
    expect(substrate.run).toContain('command -v "$tool"');
    expect(substrate.run).toContain("tmux zsh");
    expect(substrate.run).toContain("sudo apt-get install");
    expect(substrate.run).toContain("command -v tmux");
    expect(substrate.run).toContain("brew install tmux");
    expect(setup.indexOf(substrate)).toBeLessThan(setup.findIndex((step) => step.name === "Run deterministic tier"));
    expect(job.env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" });
  });

  test("manual deterministic diagnostics keep filters outside reusable caller inputs", () => {
    const callable = deterministic.on.workflow_call;
    expect(callable.inputs).toMatchObject({
      ref: { type: "string", required: true },
      runner: { type: "string", required: true },
      tier: { type: "string", required: true },
      "unit-shard": { type: "string", default: "" },
      "artifact-label": { type: "string", required: true },
    });
    expect(callable.inputs.diagnostic_filter).toBeUndefined();
    expect(callable.inputs.diagnostic_backend).toBeUndefined();
    expect(callable.secrets).toBeUndefined();
    expect(callable.outputs).toBeUndefined();
    const manual = deterministic.on.workflow_dispatch.inputs;
    expect(Object.keys(manual).sort()).toEqual(["artifact-label", "diagnostic_backend", "diagnostic_filter", "ref", "runner", "tier", "unit-shard"]);
    expect(manual.ref).toMatchObject({ type: "string", required: true });
    expect(manual.ref.default).toBeUndefined();
    expect(manual.runner).toMatchObject({
      type: "choice", required: true, default: "ubuntu-latest",
      options: ["ubuntu-latest", "macos-15", "windows-latest"],
    });
    expect(manual.tier).toMatchObject({
      type: "choice", required: true, default: "smoke",
      options: ["smoke", "unit", "integration", "e2e"],
    });
    expect(manual["unit-shard"]).toMatchObject({ type: "string", default: "" });
    expect(manual["unit-shard"].description).toContain("omit for other tiers");
    expect(manual["artifact-label"]).toMatchObject({ type: "string", required: true, default: "ci-deterministic-probe" });
    expect(manual.diagnostic_filter).toMatchObject({ type: "string", required: false, default: "" });
    expect(manual.diagnostic_backend).toMatchObject({
      type: "choice", required: false, default: "auto", options: ["auto", "node-pty"],
    });
    const backend = deterministic.jobs.test.env!.AIDLC_TUI_BACKEND;
    expect(backend).toBe(`\${{ inputs.diagnostic_backend || 'auto' }}`);
    const backendExpression = backend.match(/^\$\{\{([\s\S]+)\}\}$/)![1];
    const evaluateBackend = new Function("inputs", `return (${backendExpression});`);
    expect(evaluateBackend({})).toBe("auto");
    expect(evaluateBackend({ diagnostic_backend: "" })).toBe("auto");
    expect(evaluateBackend({ diagnostic_backend: "node-pty" })).toBe("node-pty");
    const step = steps(deterministic.jobs.test).find((step) => step.name === "Run deterministic tier")!;
    expect(step.env?.TEST_FILTER).toBe(`\${{ inputs.diagnostic_filter || '' }}`);
    // Exercise the checked-in expression for callers that have no filter input.
    const expression = step.env!.TEST_FILTER.match(/^\$\{\{([\s\S]+)\}\}$/)![1];
    const evaluate = new Function("inputs", `return (${expression});`);
    expect(evaluate({})).toBe("");
    expect(evaluate({ diagnostic_filter: "" })).toBe("");
    expect(evaluate({ diagnostic_filter: "^t-tui-runtime$" })).toBe("^t-tui-runtime$");
    expect(Object.keys(deterministic.jobs)).toEqual(["test"]);
    expect(deterministic.permissions).toEqual({ contents: "read" });
    expect(deterministic.jobs.test.permissions).toBeUndefined();
    expect(deterministic.jobs.test.environment).toBeUndefined();
    expect(deterministic.jobs.test.outputs).toBeUndefined();
    expect(JSON.stringify(deterministic)).not.toMatch(/secrets\.|id-token|ci-full-suite-result|full-suite-result\.json/);
    expect(steps(deterministic.jobs.test).find((entry) => entry.uses?.startsWith("actions/upload-artifact@"))?.with?.name)
      .toBe(`\${{ inputs.artifact-label }}-\${{ runner.os }}`);
  });

  test("shared selection rejects mutable refs, unknown tiers and misplaced unit shards", () => {
    const selection = steps(deterministic.jobs.test).find((step) => step.name === "Validate test selection")!;
    const run = (extra: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", selection.run!], {
      encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: { ...process.env, TEST_REF: identity.sha, TEST_TIER: "unit", UNIT_SHARD: "2/8", ARTIFACT_LABEL: "ci-unit-2", ...extra },
    });
    expect(run({}).status).toBe(0);
    expect(run({ UNIT_SHARD: "1/1" }).status).toBe(0);
    const manual = deterministic.on.workflow_dispatch.inputs;
    // GitHub fills the configured default for both omitted and explicitly empty
    // dispatch inputs. A nonempty unit default would make other tiers unusable.
    const runManual = (tier: string | undefined, shard?: string) => run({
      TEST_TIER: tier,
      UNIT_SHARD: shard || manual["unit-shard"].default,
      ARTIFACT_LABEL: manual["artifact-label"].default,
    });
    // The untouched form must be executable; unit still needs its own N/M shard.
    expect(manual.tier.default).not.toBe("unit");
    expect(runManual(manual.tier.default).status).toBe(0);
    expect(runManual("unit", "1/1").status).toBe(0);
    expect(runManual("unit").status).toBe(2);
    for (const tier of ["smoke", "integration", "e2e"]) {
      expect(runManual(tier).status, `${tier}: omitted shard`).toBe(0);
      expect(runManual(tier, "").status, `${tier}: empty shard`).toBe(0);
      expect(runManual(tier, "1/1").status, `${tier}: misplaced shard`).toBe(2);
    }
    for (const ref of ["main", "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      expect(run({ TEST_REF: ref }).status, ref).toBe(2);
    }
    for (const extra of [{ TEST_REF: "main" }, { TEST_TIER: "unknown" }, { TEST_TIER: "deep", UNIT_SHARD: "" }, { UNIT_SHARD: "" }, { UNIT_SHARD: "9/8" }, { ARTIFACT_LABEL: "../outside" }]) {
      const result = run(extra);
      expect(result.status, `${JSON.stringify(extra)}\n${result.stdout}\n${result.stderr}`).toBe(2);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("manual CI expands the shared matrix instead of repeating a second platform suite", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      on: { workflow_dispatch: { inputs: { platform_regressions: { type: string; default: boolean } } } };
      jobs: Record<string, Job>;
    };
    expect(ci.on.workflow_dispatch.inputs.platform_regressions).toMatchObject({ type: "boolean", default: false });
    const matrix = matrixOf(ci.jobs.deterministic);
    expect(matrix.suite).toEqual(matrixOf(workflow.jobs.deterministic).suite);
    for (const [event, enabled, expanded] of [
      ["pull_request", false, false], ["pull_request", true, false],
      ["workflow_call", true, false], ["workflow_dispatch", false, false],
      ["workflow_dispatch", true, true],
    ] as const) {
      // The selected GitHub expressions use only JS-compatible &&/|| and
      // fromJSON; exercise the actual checked-in expressions for each trigger.
      const evaluate = (value: string): unknown => {
        const expression = value.match(/^\$\{\{([\s\S]+)\}\}$/)?.[1];
        if (!expression) return value;
        return new Function("github", "inputs", "fromJSON", `return (${expression});`)(
          { event_name: event }, { platform_regressions: enabled }, JSON.parse,
        );
      };
      const runners = evaluate(matrix.runner as string) as string[];
      const excluded = evaluate(matrix.exclude!) as Array<{ suite: { name: string; tier: string } }>;
      expect(excluded).toEqual(expanded ? [] : [{ suite: { name: "e2e", tier: "e2e" } }]);
      const suites = matrix.suite!.filter((suite) =>
        !excluded.some((row) => row.suite.name === suite.name && row.suite.tier === suite.tier));
      expect(runners).toEqual(expanded ? ["ubuntu-latest", "macos-15", "windows-latest"] : ["ubuntu-latest"]);
      expect(suites.map((suite) => suite.tier)).toEqual(["smoke", ...Array(8).fill("unit"), "integration", ...(expanded ? ["e2e"] : [])]);
      expect(suites.filter((suite) => suite.tier === "unit").map((suite) => suite.shard)).toEqual(Array.from({ length: 8 }, (_, index) => `${index + 1}/8`));
      expect(new Set(runners.flatMap((runner) => suites.map((suite) => `${runner}/${suite.name}`))).size).toBe(expanded ? 33 : 10);
      if (expanded) expect(suites).toEqual(matrixOf(workflow.jobs.deterministic).suite!);
    }
    expect(ci.jobs.deterministic.with?.diagnostic_filter).toBeUndefined();
    expect(workflow.jobs.deterministic.with?.diagnostic_filter).toBeUndefined();
    expect(ci.jobs.deterministic.with?.diagnostic_backend).toBeUndefined();
    expect(workflow.jobs.deterministic.with?.diagnostic_backend).toBeUndefined();
    const manual = steps(ci.jobs.test_native_terminal).find((step) => step.name === "Run Windows node-pty compatibility on manual dispatch")!;
    expect(manual.if).toBe("github.event_name == 'workflow_dispatch' && inputs.platform_regressions && runner.os == 'Windows'");
    expect(manual.env).toEqual({ AIDLC_TUI_BACKEND: "node-pty" });
    expect(manual.run).toContain("--filter '^t-tui-node-pty-compat$'");
    expect(manual.run).toContain("sed -n '/^Verbose mode: logging to /{s/^Verbose mode: logging to //;p;q;}'");
    expect(steps(ci.jobs.test_native_terminal).some((step) => step.name === "Run platform regressions on manual dispatch")).toBe(false);
  });

  for (const [tier, shard, filter, expected] of [
    ["smoke", "", "", ["--smoke"]],
    ["unit", "3/8", "", ["--unit", "--shard", "3/8"]],
    ["integration", "", "", ["--integration"]],
    ["e2e", "", "", ["--e2e", "--isolated-e2e", "--e2e-file-timeout", "7200"]],
    ["unit", "1/1", "^t-tui-runtime$", ["--unit", "--shard", "1/1"]],
    ["unit", "7/8", '^t-(literal with spaces|"quoted"|$(printf FILTER_INJECTION))$', ["--unit", "--shard", "7/8"]],
  ] as const) {
    test(`shared ${tier} execution${filter ? ` filtered by ${filter}` : ""} preserves arguments, captured output and failure status`, () => {
      const root = mkdtempSync(join(tmpdir(), "t345-shared-tier-"));
      const step = steps(deterministic.jobs.test).find((step) => step.name === "Run deterministic tier")!;
      try {
        mkdirSync(join(root, "tests"));
        writeFileSync(join(root, "tests/run-tests.sh"), [
          "#!/bin/bash", "set -e",
          'printf "%s\\0" "$@" > "$GITHUB_WORKSPACE/argv.bin"',
          'stamp="$GITHUB_WORKSPACE/tests/logs/fixture"',
          'mkdir -p "$stamp"',
          // One write puts an outer and nested header in the capture before
          // polling; only the outer run owns the required summary.
          'printf "Verbose mode: logging to %s\\nVerbose mode: logging to %s/nested\\n" "$stamp" "$stamp"',
          'echo "captured deterministic output"',
          'echo "captured deterministic error" >&2',
          'if [ "$OMIT_SUMMARY" != 1 ]; then printf "Test files: 1\\n" > "$stamp/summary.txt"; fi',
          'exit "$FIXTURE_EXIT"',
        ].join("\n"));
        for (const [exit, omit, expectedStatus] of [["0", "0", 0], ["7", "0", 7], ["0", "1", 1]] as const) {
          rmSync(join(root, "tests/logs"), { recursive: true, force: true });
          const result = spawnSync("bash", ["-c", step.run!], {
            cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
            env: { ...process.env, GITHUB_WORKSPACE: root.replaceAll("\\", "/"), TEST_TIER: tier, UNIT_SHARD: shard, TEST_FILTER: filter, FIXTURE_EXIT: exit, OMIT_SUMMARY: omit },
          });
          expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
          expect(readFileSync(join(root, "argv.bin"), "utf8").split("\0").filter(Boolean))
            .toEqual([
              "--debug", "-P", "8", "--no-llm", ...expected, ...(filter ? ["--filter", filter] : []),
              "--file-timeout", "7200", "--run-timeout", "14400",
            ]);
          expect(readFileSync(join(root, "tmp/ci-deterministic/run.log"), "utf8")).toContain("captured deterministic output");
          expect(readFileSync(join(root, "tmp/ci-deterministic/run.log"), "utf8")).toContain("captured deterministic error");
          expect(readFileSync(join(root, "tmp/ci-deterministic/stamp.txt"), "utf8").trim())
            .toBe(`${root.replaceAll("\\", "/")}/tests/logs/fixture`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("native terminal CI selects only executable platform units across every runner alias", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, Job>;
    };
    const matrix = matrixOf(ci.jobs.test_native_terminal).include!;
    const shared = ["runtime", "bun-process", "native-private-root", "native-fixture-cleanup"];
    const owned: Record<string, string[]> = {
      linux: ["bun-process-linux", "native-private-root-posix"],
      darwin: ["bun-process-darwin", "native-private-root-posix"],
      win32: ["native-private-root-windows"],
    };
    const files = [...new Bun.Glob("*.test.ts").scanSync({ cwd: join(REPO_ROOT, "tests/unit") })]
      .map((file) => `tests/unit/${file}`);
    expect(matrix.map((row) => platformOf(row.runner)).sort()).toEqual(Object.keys(owned).sort());
    for (const row of matrix) {
      const platform = platformOf(row.runner);
      const filter = new RegExp(row.filter);
      // Same OR matching as run-tests.ts: basename (with extension), legacy
      // stem, and tier-qualified stem. The extension alias defeated lookaheads.
      const selected = files.filter((file) => aliases(file).some((alias) => filter.test(alias))).sort();
      const expected = [...shared, ...owned[platform]].map((name) => `tests/unit/t-tui-${name}.test.ts`).sort();
      expect(selected, `${row.runner}: ${row.filter}`).toEqual(expected);
      for (const file of selected) {
        const suffix = /-(posix|windows|linux|darwin)\.test\.ts$/.exec(file)?.[1];
        if (suffix) {
          const allowed = suffix === "posix" ? ["linux", "darwin"] : [suffix === "windows" ? "win32" : suffix];
          expect(allowed, `${row.runner} selected foreign-platform ${file}`).toContain(platform);
        }
      }
    }
  });

  test("release and live-verification runs always prepare and execute isolated hosted live jobs", () => {
    const jobs = Object.entries(workflow.jobs);
    const oidcJobs = jobs.filter(([, job]) => job.permissions?.["id-token"] === "write").map(([name]) => name).sort();
    expect(oidcJobs).toEqual(["live_hosted", "live_windows"]);
    for (const name of ["live_prepare", ...oidcJobs]) {
      const needs = workflow.jobs[name].needs;
      expect(Array.isArray(needs) ? needs : [needs]).toContain("plan");
    }
    expect(workflow.jobs.live_prepare.if).toBe("needs.plan.outputs.purpose != 'full-verification'");
    for (const kind of ["hosted", "windows"] as const) {
      expect(workflow.jobs[`live_${kind}`].if)
        .toBe(`needs.plan.outputs.purpose != 'full-verification' && needs.plan.outputs.live_${kind}_required == 'true'`);
      expect(liveMatrix(kind).include.length).toBeGreaterThan(0);
    }
    expect(workflow.jobs.live_prepare.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.live_prepare.environment).toBeUndefined();
    expect(workflow.on.workflow_call.secrets).toBeUndefined();
    for (const name of oidcJobs) {
      const job = workflow.jobs[name];
      expect(job.environment).toBe("ai-pr-review");
      expect(job.needs).toContain("live_prepare");
      const download = steps(job).findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
      const prepare = steps(job).findIndex((step) => step.name === "Prepare separate-user live runtime");
      expect(download).toBeGreaterThanOrEqual(0);
      expect(download).toBeLessThan(prepare);
      for (const step of steps(job)) {
        expect(step.run ?? "").not.toMatch(/\b(bun|npm|npx|pnpm|yarn|pip|pip3|cargo)\s+(install|i|ci|add)\b/);
        expect(step.run ?? "").not.toContain("scripts/package.ts");
      }
    }
  });

  test("Linux Codex uses distro bubblewrap and a scoped AppArmor profile before credentials", () => {
    const source = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.sh"), "utf8");
    const provisioning = source.slice(source.indexOf("prepare_linux_bwrap()"), source.indexOf("prove_linux_bwrap()"));
    expect(provisioning).toContain("sudo apt-get install -y -qq bubblewrap");
    expect(provisioning).toContain("sudo apt-get install -y -qq apparmor-profiles apparmor-utils");
    expect(provisioning).toContain('if [[ ! -f "$profile" ]]');
    expect(provisioning).toContain("profile=/etc/apparmor.d/bwrap-userns-restrict");
    expect(provisioning).toContain('sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict "$profile"');
    expect(provisioning).toContain('sudo apparmor_parser -r "$profile"');
    expect(provisioning).toContain('if [[ "$prior" == 1 ]]');
    expect(provisioning).toContain('$(cat "$restriction")" != "$prior"');
    expect(source).not.toMatch(/\bsysctl\b|apparmor_restrict_unprivileged_userns\s*=\s*0/);
    expect(source).toContain('if [[ "$family" == codex ]]; then prepare_linux_bwrap; fi');
    expect(source.indexOf("then prepare_linux_bwrap; fi")).toBeLessThan(source.indexOf("sudo adduser"));
    expect(source).toContain('sudo ln -s /usr/bin/bwrap "$live_tools/bin/bwrap"');
    const proofs = source.slice(source.indexOf('if [[ "$mode" == prepare || "$mode" == prove ]]'));
    expect(proofs).toContain('if [[ "$(uname -s)" == Linux && "$family" == codex ]]; then\n    prove_linux_bwrap');
    expect(proofs.indexOf("prove_linux_bwrap")).toBeGreaterThan(proofs.indexOf('if run_live test -r "$GITHUB_ENV"'));
    const hosted = steps(workflow.jobs.live_hosted);
    const prepare = hosted.findIndex((step) => step.name === "Prepare separate-user live runtime");
    const credentials = hosted.findIndex((step) => step.id === "aws");
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(credentials);
    expect(hosted[prepare].if).toBeUndefined();
    expect(hosted.find((step) => step.name === "Prove isolation")?.run)
      .toBe(`bash .github/scripts/prepare-live-runtime.sh prove \${{ matrix.family }}`);
  });

  test("Codex namespace proof requires distro PATH, propagates failure and cleans only its sentinels", () => {
    const source = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.sh"), "utf8");
    const proof = source.match(/^prove_linux_bwrap\(\) \([\s\S]*?^\)/m)![0];
    const root = mkdtempSync(join(tmpdir(), "t345-bwrap-"));
    try {
      for (const directory of ["runner", "tools"]) mkdirSync(join(root, directory));
      const script = [
        "set -euo pipefail",
        'live_tools="$PROBE_ROOT/tools"; live_home="$PROBE_ROOT/live"; live_root="$live_home/workspace"',
        // Mock only the OS boundary; no real sudo, user creation or namespaces in unit tests.
        'sudo() { case "$1" in mktemp|rm) "$@" ;; *) return 99 ;; esac; }',
        'run_live() { if [[ "$1" == /bin/bash ]]; then printf "%s\\n" "$BWRAP_PATH"; else printf "%s\\0" "$@" > "$PROBE_ARGS"; return "$BWRAP_EXIT"; fi; }',
        proof, "prove_linux_bwrap", "echo PROBE_COMPLETE",
      ].join("\n");
      const argv = join(root, "argv.bin");
      for (const [path, exit, expected] of [["/usr/bin/bwrap", "0", 0], ["/usr/bin/bwrap", "17", 17], ["/bundled/bwrap", "0", 1]] as const) {
        rmSync(argv, { force: true });
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
          env: {
            ...process.env, PROBE_ROOT: root.replaceAll("\\", "/"), PROBE_ARGS: argv.replaceAll("\\", "/"),
            RUNNER_TEMP: join(root, "runner").replaceAll("\\", "/"), GITHUB_WORKSPACE: root.replaceAll("\\", "/"),
            GITHUB_ENV: join(root, "environment").replaceAll("\\", "/"), BWRAP_PATH: path, BWRAP_EXIT: exit,
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(expected);
        expect(result.stdout.includes("PROBE_COMPLETE")).toBe(expected === 0);
        expect(readdirSync(join(root, "runner"))).toEqual([]);
        expect(readdirSync(join(root, "tools"))).toEqual([]);
        if (path !== "/usr/bin/bwrap") {
          expect(existsSync(argv)).toBe(false);
          continue;
        }
        const args = readFileSync(argv, "utf8").split("\0").filter(Boolean);
        expect(args.slice(0, 11)).toEqual(["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--cap-drop", "ALL", "--ro-bind", "/", "/"]);
        const body = args[args.indexOf("-c") + 1];
        expect(body).toContain('[[ "$(id -u)" == 0 ]]');
        expect(body).toContain('[[ "$(cat "$probe")" == namespace-write ]]');
        expect(body).toContain("bun --version");
        expect(body).toContain('if cat "$denied" >/dev/null 2>&1; then');
        expect(args.some((arg) => /^\/proc\/\d+\/environ$/.test(arg))).toBe(true);
        expect(args.at(-2)).toContain("/runner/bwrap-runner.");
        expect(args.at(-1)).toContain("/tools/bwrap-host.");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("POSIX live preparation transports a complete pinned Node prefix before credentialed startup", () => {
    const prepare = steps(workflow.jobs.live_prepare);
    const node = prepare.find((step) => step.name === "Prepare pinned POSIX Node runtime")!;
    expect(node.uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
    expect(node.if).toBe("runner.os != 'Windows'");
    expect(node.with).toMatchObject({ "node-version": `\${{ env.NODE_VERSION }}`, "package-manager-cache": false });
    expect(workflow.env.NODE_VERSION).toBe("22.23.2");
    expect(prepare.indexOf(node)).toBeLessThan(prepare.findIndex((step) => step.run === "bun install --frozen-lockfile"));
    expect(prepare.find((step) => step.name === "Pack POSIX live dependencies")?.run).toContain('--node-runtime "$node_root"');
    const source = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.sh"), "utf8");
    expect(source).not.toContain('sudo install -m 755 "$node_bin"');
    expect(source).toContain('sudo cp -a "$node_root" "$live_tools/node"');
    expect(source).toContain('live_path="$live_tools/node/bin:');
    const protect = source.indexOf('sudo chmod 700 "$HOME" "$RUNNER_TEMP" "$GITHUB_WORKSPACE"');
    expect(source.indexOf("run_live node --version")).toBeGreaterThan(protect);
    expect(source.indexOf('run_live "$cli" --version')).toBeGreaterThan(protect);
    for (const name of ["live_hosted", "live_windows"]) {
      expect(steps(workflow.jobs[name]).some((step) => step.uses?.startsWith("actions/setup-node@"))).toBe(false);
    }
  });

  test("prepared POSIX dependency archives retain Node libraries and refuse incomplete runtimes", () => {
    const root = mkdtempSync(join(tmpdir(), "t345-node-deps-"));
    try {
      const workspace = join(root, "source");
      const destination = join(root, "destination");
      const temporary = join(root, "temporary");
      const cli = join(root, "cli");
      const node = join(root, "node");
      for (const path of [destination, temporary, cli, join(node, "bin"), ...["node_modules", "dist", "dist-release"].map((name) => join(workspace, name))]) {
        mkdirSync(path, { recursive: true });
      }
      writeFileSync(join(node, "bin/node"), "prepared Node executable\n");
      const archive = join(root, "deps.tar.gz");
      const script = join(REPO_ROOT, "scripts/ci-live-deps.py");
      const run = (...args: string[]) => spawnSync(process.platform === "win32" ? "python" : "python3", [script, ...args], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
      });
      const pack = ["pack", archive, "--workspace", workspace, "--cli", cli];
      const missing = run(...pack);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("complete Node runtime");
      const incomplete = run(...pack, "--node-runtime", node);
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain("requires bin/node and its lib directory");
      const unpack = ["unpack", archive, "--workspace", destination, "--temporary", temporary, "--posix-clis"];
      expect(run(...unpack).status).not.toBe(0);
      expect(existsSync(join(destination, "node_modules"))).toBe(false);
      mkdirSync(join(node, "lib/node_modules/npm/bin"), { recursive: true });
      writeFileSync(join(node, "lib/libnode.fixture"), "required runtime library\n");
      writeFileSync(join(node, "lib/node_modules/npm/bin/npm-cli.js"), "prepared npm\n");
      const packed = run(...pack, "--node-runtime", node);
      expect(packed.status, packed.stderr).toBe(0);
      rmSync(node, { recursive: true, force: true });
      const unpacked = run(...unpack);
      expect(unpacked.status, unpacked.stderr).toBe(0);
      expect(readFileSync(join(temporary, "aidlc-node/bin/node"), "utf8")).toBe("prepared Node executable\n");
      expect(readFileSync(join(temporary, "aidlc-node/lib/libnode.fixture"), "utf8")).toBe("required runtime library\n");
      expect(readFileSync(join(temporary, "aidlc-node/lib/node_modules/npm/bin/npm-cli.js"), "utf8")).toBe("prepared npm\n");
      expect(existsSync(join(temporary, "aidlc-cli"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("POSIX collection retires macOS user domains and refuses remaining executable processes", () => {
    const source = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.sh"), "utf8");
    const collect = source.slice(source.indexOf('elif [[ "$mode" == collect ]]'));
    expect(collect.indexOf('sudo launchctl bootout "$domain"')).toBeLessThan(collect.indexOf("sudo pkill"));
    expect(collect).toContain('"gui/$live_uid" "user/$live_uid"');
    expect(collect.indexOf('remaining="$(active_live_processes)"')).toBeLessThan(collect.indexOf('sudo cp -a "$live_root/tests/logs/."'));
    const filter = source.match(/awk -v uid="\$live_uid" '([^']+)'/)![1];
    const result = spawnSync("bash", ["-c", 'awk -v uid=502 "$1"', "collection-filter", filter], {
      encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
      input: "501 10 S runner\n502 11 Z zombie\n502 12 Z+ zombie-child\n502 13 S worker\n502 14 R child\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("502 13 S worker\n502 14 R child\n");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("credentialed startup is isolated from broker and agent environments", () => {
    const source = {
      PATH: "/bin", RUNNER_TRACKING_ID: "owned", GITHUB_ACTIONS: "true",
      BROKER_ACCESS_KEY_ID: "real-access", BROKER_SECRET_ACCESS_KEY: "real-secret", BROKER_SESSION_TOKEN: "real-token",
      AWS_ACCESS_KEY_ID: "real-access", AWS_SECRET_ACCESS_KEY: "real-secret", AWS_SESSION_TOKEN: "real-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc", GH_TOKEN: "github", GITHUB_TOKEN: "github",
      ANTHROPIC_API_KEY: "anthropic", KIRO_API_KEY: "kiro", CURSOR_API_KEY: "cursor",
      AIDLC_BROKER_URL: "http://127.0.0.1:1234", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    };
    expect(brokerChildEnvironment(source)).toEqual({ PATH: "/bin", RUNNER_TRACKING_ID: "owned", GITHUB_ACTIONS: "true" });
    const agent = liveRunnerEnvironment(source);
    for (const key of ["BROKER_ACCESS_KEY_ID", "BROKER_SECRET_ACCESS_KEY", "BROKER_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(agent[key]).toBeUndefined();
    }
    expect(agent.KIRO_API_KEY).toBeUndefined();
    expect(agent.CURSOR_API_KEY).toBeUndefined();
    expect(agent.AIDLC_BROKER_URL).toBe(source.AIDLC_BROKER_URL);
  });

  test("Bedrock workflow hands credentials only to stdin broker startup, never a live step", () => {
    for (const name of ["live_hosted", "live_windows"]) {
      const job = workflow.jobs[name];
      const assume = steps(job).find((step) => step.name === "Assume nightly Bedrock role")!;
      expect(assume.with).toMatchObject({
        "role-to-assume": `\${{ secrets.AWS_AI_PR_REVIEW_ROLE_ARN }}`,
        "role-duration-seconds": 3600,
        "output-credentials": true, "output-env-credentials": false,
      });
      const startup = steps(job).find((step) => step.name === "Start credential-isolated Bedrock broker")!;
      expect(startup.run).toContain("ci-start-credential-broker.ts");
      expect(startup.env?.BROKER_ACCESS_KEY_ID).toBe(`\${{ steps.aws.outputs.aws-access-key-id }}`);
      expect(steps(job).find((step) => step.name === "Assert live runner has no AWS credentials")).toBeDefined();
    }
    for (const [name, live] of Object.entries(workflow.jobs)) {
      if (!name.startsWith("live_")) continue;
      for (const step of steps(live)) {
        for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AIDLC_BROKER_TOKEN"]) expect(step.env?.[key]).toBeUndefined();
        if (step.name !== "Start credential-isolated Bedrock broker") expect(JSON.stringify(step.env ?? {})).not.toContain("steps.aws.outputs.");
      }
    }
  });

  test("merge-queue CI exercises the same OS identity boundary without provider credentials", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { needs?: string[]; permissions?: Record<string, string>; strategy?: { matrix: { runner: string[] } }; steps: Step[] }>;
    };
    const job = ci.jobs.test_live_isolation;
    expect(job.strategy?.matrix.runner).toEqual(["ubuntu-latest", "macos-15", "windows-latest"]);
    expect(job.permissions?.["id-token"]).toBeUndefined();
    expect(ci.jobs.test.needs).toContain("test_live_isolation");
    expect(steps(job).find((step) => step.name === "Prove POSIX isolation")?.run).toBe("bash .github/scripts/prepare-live-runtime.sh prove");
    expect(steps(job).find((step) => step.name === "Prove Windows isolation")?.run).toBe(".github/scripts/prepare-live-runtime.ps1 -Mode prove");
    expect(steps(job).find((step) => step.name === "Exercise POSIX isolated smoke command")?.run).toContain("prepare-live-runtime.sh smoke");
    expect(steps(job).find((step) => step.name === "Exercise Windows isolated smoke command")?.run).toContain("prepare-live-runtime.ps1 -Mode smoke");
    expect(JSON.stringify(job)).not.toContain("secrets.");
  });

  test("PR pushes run the Linux gate; the merge queue and manual runs add the cross-OS jobs", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      on: Record<string, unknown>;
      jobs: Record<string, Job>;
    };
    expect(ci.on.merge_group).toEqual({ types: ["checks_requested"] });
    for (const name of ["test_native_terminal", "test_live_isolation"]) expect(ci.jobs[name].if).toBe("github.event_name != 'pull_request'");
    for (const name of ["check", "deterministic", "test_guards"]) expect(ci.jobs[name].if).toBeUndefined();
    // A skipped need would skip the summary under the default success() gate.
    expect(ci.jobs.test.if).toBe(`\${{ !cancelled() }}`);
    expect(ci.jobs.test.needs).toEqual(["deterministic", "test_native_terminal", "test_guards", "test_live_isolation"]);
    const summary = steps(ci.jobs.test)[0];
    expect(summary.env?.EVENT_NAME).toBe(`\${{ github.event_name }}`);
    const status = (event: string, results: Record<string, string>) => spawnSync("bash", ["-e", "-c", summary.run!], {
      encoding: "utf8", timeout: 15_000,
      env: { ...process.env, EVENT_NAME: event, DETERMINISTIC_RESULT: "success", GUARD_RESULT: "success", ...results },
    }).status;
    for (const event of ["pull_request", "merge_group", "workflow_dispatch", "workflow_call"]) {
      const expected = event === "pull_request" ? "skipped" : "success";
      const crossOs = { NATIVE_RESULT: expected, ISOLATION_RESULT: expected };
      expect(status(event, crossOs), event).toBe(0);
      for (const key of ["DETERMINISTIC_RESULT", "GUARD_RESULT", "NATIVE_RESULT", "ISOLATION_RESULT"]) {
        for (const result of ["failure", "cancelled"]) expect(status(event, { ...crossOs, [key]: result }), `${event} ${key}=${result}`).not.toBe(0);
      }
      // The merge queue cannot pass on cross-OS jobs that never ran.
      if (event !== "pull_request") {
        for (const key of ["NATIVE_RESULT", "ISOLATION_RESULT"]) expect(status(event, { ...crossOs, [key]: "skipped" }), `${event} ${key}=skipped`).not.toBe(0);
      }
    }
  });

  test("a newer manual Full Suite dispatch supersedes the same branch and selection; called runs never cancel", () => {
    const { concurrency } = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/full-suite.yml"), "utf8")) as {
      concurrency: { group: string; "cancel-in-progress": string };
    };
    const format = (template: string, ...args: unknown[]) => template.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
    // The expressions use only JS-compatible !=/&&/|| plus format; an absent input is null in
    // GitHub and undefined here, and both are loosely equal to null.
    const evaluate = (value: string, github: Record<string, string>, inputs: Record<string, unknown>): unknown =>
      new Function("github", "inputs", "format", `return (${value.match(/^\$\{\{([\s\S]+)\}\}$/)![1]});`)(github, inputs, format);
    const run = (github: Record<string, string>, inputs: Record<string, unknown>) => ({
      group: evaluate(concurrency.group, github, inputs), cancel: evaluate(concurrency["cancel-in-progress"], github, inputs),
    });
    // A direct dispatch always carries every workflow_dispatch input, verification_family included.
    const dispatch = (branch: string, runId: string) => ({
      workflow: "Full Suite", workflow_ref: `awslabs/aidlc-workflows/.github/workflows/full-suite.yml@refs/heads/${branch}`,
      ref: `refs/heads/${branch}`, run_id: runId,
    });
    const [h1, h2] = ["1".repeat(40), "2".repeat(40)];
    const live = { ref: h1, live_verification: true, verification_family: "all", verification_test: "" };
    const first = run(dispatch("candidate", "1"), live);
    expect(first.cancel).toBe(true);
    // Verification is dispatched with the exact branch head, so a push-and-redispatch must supersede the older head.
    expect(run(dispatch("candidate", "2"), { ...live, ref: h2 })).toEqual(first);
    const release = { ref: h1, live_verification: false, verification_family: "all", verification_test: "" };
    expect(run(dispatch("main", "2"), release)).toEqual(run(dispatch("main", "1"), release));
    for (const [github, inputs] of [
      [dispatch("other", "2"), live],
      [dispatch("candidate", "2"), { ...live, verification_family: "codex" }],
      [dispatch("candidate", "2"), { ...live, verification_family: "codex", verification_test: "tests/e2e/t-exec-codex-status.serial.test.ts" }],
      [dispatch("candidate", "2"), { ...live, live_verification: false }],
    ] as const) {
      expect(run(github, inputs).group, JSON.stringify({ github, inputs })).not.toBe(first.group);
    }
    // Release-purpose reruns for distinct SHAs coexist.
    expect(run(dispatch("main", "2"), { ...release, ref: h2 }).group).not.toBe(run(dispatch("main", "1"), release).group);
    // Called runs carry the caller's github context and only the ref input, even when the caller
    // shares this display name or, from another repository, this file path.
    for (const [workflow, workflowRef] of [
      ["Preview Release", "awslabs/aidlc-workflows/.github/workflows/preview-release.yml@refs/heads/main"],
      ["Full Suite", "example/consumer/.github/workflows/full-suite.yml@refs/heads/main"],
    ]) {
      const called = (runId: string, ref = h1) => run({ workflow, workflow_ref: workflowRef, ref: "refs/heads/main", run_id: runId }, { ref });
      expect(called("10"), workflowRef).toEqual({ group: `full-suite-call-10-${h1}`, cancel: false });
      expect(called("11").group).not.toBe(called("10").group);
      expect(called("10").group).not.toBe("release-preview");
      // A group holds one running and one pending run, so a third call sharing one would
      // replace the second: calls for distinct refs in one caller run must not share a group.
      const sameRun = [h1, h2, "3".repeat(40)].map((ref) => called("10", ref).group);
      expect(new Set(sameRun).size).toBe(3);
    }
  });

  test("all tests/logs uploads require successful sanitization even after test failure", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const [index, step] of steps(job).entries()) {
        const path = step.with?.path;
        if (!step.uses?.startsWith("actions/upload-artifact@") || typeof path !== "string" || !path.split("\n").includes("tests/logs/")) continue;
        const sanitize = steps(job)[index - 1];
        expect(sanitize).toMatchObject({ id: "sanitize", if: `\${{ always() }}` });
        expect(sanitize.env?.AIDLC_NIGHTLY_UPLOAD_TRACES).toBe(`\${{ vars.AIDLC_NIGHTLY_UPLOAD_TRACES || '1' }}`);
        expect(sanitize.run).toContain("bun scripts/ci-sanitize-logs.ts tests/logs");
        if (path.includes("tmp/full-suite-native/")) expect(sanitize.run).toContain("bun scripts/ci-sanitize-logs.ts tmp/full-suite-native");
        expect(step.if).toBe(`\${{ always() && steps.sanitize.outcome == 'success' }}`);
      }
    }
    const sharedSteps = steps(deterministic.jobs.test);
    const upload = sharedSteps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    const sanitize = sharedSteps.find((step) => step.id === "sanitize")!;
    expect(sanitize.if).toBe(`\${{ always() }}`);
    expect(sanitize.env?.AIDLC_NIGHTLY_UPLOAD_TRACES).toBe(`\${{ vars.AIDLC_NIGHTLY_UPLOAD_TRACES || '1' }}`);
    expect(sanitize.run).toContain("bun scripts/ci-sanitize-logs.ts tests/logs");
    expect(sanitize.run).toContain("bun scripts/ci-sanitize-logs.ts tmp/ci-deterministic");
    expect(upload.if).toBe(`\${{ always() && steps.sanitize.outcome == 'success' }}`);
    expect(upload.with).toMatchObject({ "retention-days": 90, "include-hidden-files": true, "if-no-files-found": "error" });
    expect(upload.with?.path).toBe("tests/logs/\ntmp/ci-deterministic/\n");
  });

  test("CI model allowlist and Codex profile preserve proxy routing without credential export", () => {
    expect(CI_BEDROCK_MODELS.claude).toMatchObject({
      ANTHROPIC_DEFAULT_FABLE_MODEL: "global.anthropic.claude-fable-5[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-4-8[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(CI_BEDROCK_MODELS.claude.ANTHROPIC_DEFAULT_SONNET_MODEL.replace("[1m]", "")).toBe(CI_BEDROCK_MODELS.opencode);
    const previous = process.env.AIDLC_BROKER_URL;
    process.env.AIDLC_BROKER_URL = "http://127.0.0.1:1234";
    const project = setupCodexProject();
    try {
      const config = parse(readFileSync(join(project.home, "config.toml"), "utf8"));
      expect(config.model).toBe(CI_BEDROCK_MODELS.codex);
      expect(config.model_providers).toMatchObject({ "amazon-bedrock": { base_url: "http://127.0.0.1:1234/openai/v1" } });
      expect(config.shell_environment_policy).toEqual({
        exclude: ["AWS_*", "AIDLC_BROKER_*", "ANTHROPIC_*", "KIRO_API_KEY", "CURSOR_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_*"],
        set: { AIDLC_RULES_DIR: ".codex/aidlc-rules" },
      });
    } finally {
      if (previous === undefined) delete process.env.AIDLC_BROKER_URL;
      else process.env.AIDLC_BROKER_URL = previous;
      rmSync(project.root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("live families have every supported platform, opt-ins and strictness, without no-LLM", () => {
    const actual: string[] = [];
    const partition = classifyLiveFiles(REPO_ROOT);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(job["runs-on"] ?? []).not.toContain("self-hosted");
      if (!jobName.startsWith("live_") && jobName !== "release_contract_windows") continue;
      for (const step of steps(job)) {
        expect(step.run ?? "").not.toMatch(/--(?:no-llm|unit|integration|e2e|isolated-e2e|bedrock-parallel|kiro-parallel|ide-parallel|require-coverage)\b/);
        expect(step.run ?? "").not.toContain("mapfile");
        expect(step.run ?? "").not.toContain(`\${ARGS`);
      }
      for (const row of rows(job)) {
        const family = FAMILIES[row.family];
        expect(family, row.family).toBeDefined();
        const files = partition.get(row.family)!.filter((file) =>
          !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(row.platform as NodeJS.Platform));
        if (row.shard) {
          const [index, total] = row.shard.split("/").map(Number);
          expect(total).toBe(files.length);
          expect(index).toBeGreaterThan(0);
          expect(index).toBeLessThanOrEqual(total);
          actual.push(`${row.family}:${row.platform}:${files[index - 1]}`);
        } else {
          actual.push(...files.map((file) => `${row.family}:${row.platform}:${file}`));
        }
        const run = steps(job).find((step) => step.name === `Run ${row.family}`);
        expect(run, `${jobName}/${row.family} command`).toBeDefined();
        expect({ ...job.env, ...run!.env }).toMatchObject(family.env);
        expect(run!["timeout-minutes"]).toBe(70);
        const command = run!.run!.replaceAll(`\${{ matrix.platform }}`, row.platform)
          .replaceAll(`\${{ matrix.shard }}`, row.shard ?? "").trim();
        if (jobName === "live_hosted") {
          expect(command).toContain("sudo -u aidlc-live -H env -i");
          expect(command).toContain('cd "$AIDLC_LIVE_ROOT" && exec "$@"');
          expect(command).toContain(`ci-live-sandbox.ts" ${row.family} ${row.platform} "${row.shard}"`);
          const proof = steps(job).findIndex((step) => step.name === "Prove isolation");
          expect(proof).toBeGreaterThanOrEqual(0);
          expect(proof).toBeLessThan(steps(job).indexOf(run!));
        } else if (jobName === "live_windows") {
          expect(command).toBe(`.github/scripts/prepare-live-runtime.ps1 -Mode run -Family ${row.family} -Shard '${row.shard}'`);
          const proof = steps(job).findIndex((step) => step.name === "Prove isolation");
          expect(proof).toBeGreaterThanOrEqual(0);
          expect(proof).toBeLessThan(steps(job).indexOf(run!));
        } else {
          expect(job.if).toBe("needs.plan.outputs.verification_family == 'all'");
          expect(command).toBe(`bun scripts/ci-live-filter.ts ${row.family} --platform ${row.platform} --run -- --debug -P 8`);
        }
      }
    }
    const expected = Object.entries(FAMILIES).flatMap(([family, spec]) => spec.platforms.flatMap((platform) =>
      partition.get(family as LiveFamily)!.filter((file) => !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform))
        .map((file) => `${family}:${platform}:${file}`)));
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("live jobs use authorized dynamic matrices and leave time for collection before credentials expire", () => {
    const plan = steps(workflow.jobs.plan);
    const discovery = plan.find((step) => step.id === "live_matrix")!;
    expect(plan.indexOf(discovery)).toBeGreaterThan(plan.findIndex((step) => step.id === "source"));
    expect(plan.indexOf(discovery)).toBeGreaterThan(plan.findIndex((step) => step.run === "bun install --frozen-lockfile"));
    expect(discovery.if).toBeUndefined();
    expect(discovery.env?.VERIFICATION_TEST).toBe(`\${{ steps.source.outputs.verification_test }}`);
    expect(matrixOf(workflow.jobs.live_prepare)).toEqual({
      runner: [...new Set(["live_hosted", "live_windows"].flatMap(name =>
        matrixOf(workflow.jobs[name]).include!.map(row => row.runner)))],
    });
    expect(rows(workflow.jobs.live_prepare)).toEqual([]);
    for (const kind of ["hosted", "windows"] as const) {
      const job = workflow.jobs[`live_${kind}`];
      expect(discovery.run).toContain(`bun scripts/ci-live-filter.ts --matrix ${kind}`);
      expect(discovery.run).toContain('--family "$VERIFICATION_FAMILY"');
      expect(discovery.run).toContain('--test "$VERIFICATION_TEST"');
      expect(workflow.jobs.plan.outputs?.[`live_${kind}_matrix`]).toBe(`\${{ steps.live_matrix.outputs.${kind} }}`);
      expect(job.strategy?.matrix).toBe(`\${{ fromJSON(needs.plan.outputs.live_${kind}_matrix) }}`);
      expect(job.strategy?.["max-parallel"]).toBe(kind === "hosted" ? 12 : 6);
      expect(job.strategy?.["fail-fast"]).toBe(false);
      expect(job["timeout-minutes"]).toBe(80);
      expect(steps(job).find((step) => step.name === "Collect isolated live logs")?.if).toBe(`\${{ always() }}`);
      expect(steps(job).find((step) => step.name === "Upload diagnostic logs")?.with?.name).toContain(`\${{ matrix.slice }}`);
    }
    expect(steps(workflow.jobs.plan).find((step) => step.run === "bun install --frozen-lockfile")?.if).toBeUndefined();
    expect(discovery.env?.VERIFICATION_FAMILY).toBe(`\${{ steps.source.outputs.verification_family }}`);
  });

  test("exact-file verification preserves full-plan shard identities and declared platforms", () => {
    const file = "tests/integration/t238-user-stories-mob.sdk.test.ts";
    for (const kind of ["hosted", "windows"] as const) {
      const full = liveMatrix(kind, "claude-sdk").include;
      const selected = liveMatrix(kind, "claude-sdk", file).include;
      expect(selected).toHaveLength(kind === "hosted" ? 2 : 1);
      for (const row of selected) {
        expect(full).toContainEqual(row);
        expect(selectedLiveFiles(row.family, row.platform, row.shard)).toEqual([file]);
      }
      const cli = spawnSync(process.execPath, [
        join(REPO_ROOT, "scripts/ci-live-filter.ts"), "--matrix", kind, "--family", "claude-sdk", "--test", file,
      ], { encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
      expect(cli.status, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual({ include: selected });
      expect(() => liveMatrix(kind, "all", file)).toThrow("requires one verification family");
      expect(() => liveMatrix(kind, "codex", file)).toThrow("must belong to codex");
      expect(() => liveMatrix(kind, "claude-sdk", "tests/integration/missing.test.ts")).toThrow();
    }
    const windowsFile = "tests/e2e/t-tui-windows-user-settings-isolation.serial.test.ts";
    expect(liveMatrix("hosted", "claude-tui", windowsFile).include).toEqual([]);
    const windows = liveMatrix("windows", "claude-tui", windowsFile).include;
    expect(windows).toHaveLength(1);
    expect(selectedLiveFiles(windows[0].family, windows[0].platform, windows[0].shard)).toEqual([windowsFile]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("sandbox env is explicit and excludes runner control-plane and AWS secrets", () => {
    const inherited = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "mint-token", AWS_ACCESS_KEY_ID: "secret-key", GITHUB_TOKEN: "github",
      AIDLC_BROKER_URL: "http://127.0.0.1:1234", AIDLC_BROKER_IDENTITY: JSON.stringify({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/ci/test" }),
    };
    for (const family of ["claude-sdk", "claude-tui", "codex", "opencode", "release-contract"] as const) {
      const env = sandboxEnvironment(family, "/home/aidlc-live", "/usr/local/lib/aidlc-live/bin:/usr/bin:/bin", inherited);
      expect(env.PATH).toBe("/usr/local/lib/aidlc-live/bin:/usr/bin:/bin");
      expect(env.HOME).toBe("/home/aidlc-live");
      expect(env.TMPDIR).toBe(join("/home/aidlc-live", "tmp"));
      expect(env.BUN_INSTALL).toBe(join("/home/aidlc-live", ".bun"));
      expect(env.XDG_CACHE_HOME).toBe(join("/home/aidlc-live", ".cache"));
      expect(Object.keys(env).filter((key) => /^(ACTIONS_|AWS_|GITHUB_TOKEN|GH_TOKEN)/.test(key)))
        .toEqual(family === "opencode" ? ["AWS_PROFILE"] : []);
      if (family === "opencode") expect(env.AWS_PROFILE).toBe("broker");
      expect(env).toMatchObject(FAMILIES[family].env);
      const windows = sandboxEnvironment(family, "C:\\aidlc-live\\home", "C:\\aidlc-live\\tools", {
        ...inherited, PATHEXT: ".UNTRUSTED",
      });
      // Native `where claude` needs the executable suffix list after scrubbing.
      expect(windows.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
      expect(windows.PATH).toBe("C:\\aidlc-live\\tools");
      expect(Object.keys(windows).filter((key) => /^(ACTIONS_|AWS_|GITHUB_TOKEN|GH_TOKEN)/.test(key)))
        .toEqual(family === "opencode" ? ["AWS_PROFILE"] : []);
    }
    const managed = "C:\\aidlc-live\\tools\\codex-managed.exe";
    const native = sandboxEnvironment("codex", "C:\\aidlc-live\\home", "C:\\aidlc-live\\tools", {
      ...inherited, AIDLC_CODEX_BIN: managed,
    });
    expect(native.AIDLC_CODEX_BIN).toBe(managed);
    expect(() => sandboxEnvironment("codex", "C:\\aidlc-live\\home", "C:\\aidlc-live\\tools", {
      ...inherited, AIDLC_CODEX_BIN: "C:\\runner\\untrusted.cmd",
    })).toThrow("sealed native Codex launcher");
  });

  test("Kiro and Cursor are excluded without exposing vendor API keys", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(name).not.toContain("kiro");
      const matrix = matrixOf(job);
      for (const family of [...(matrix?.family ?? []), ...(matrix?.include ?? []).map((row) => row.family ?? "")]) {
        expect(family).not.toContain("kiro");
      }
    }
    expect(workflow.jobs.live_cursor).toBeUndefined();
    expect(workflow.on.workflow_call.secrets?.KIRO_API_KEY).toBeUndefined();
    expect(workflow.on.workflow_call.secrets?.CURSOR_API_KEY).toBeUndefined();
    for (const family of ["kiro-ide", "kiro-tui", "kiro-acp"] as const) {
      expect(FAMILIES[family]).toMatchObject({
        hosting: "excluded", platforms: [],
        reason: "needs a dedicated isolated Windows desktop host with a separate low-privilege Kiro identity; tracked as a follow-up",
      });
    }
    expect(FAMILIES.cursor).toMatchObject({ hosting: "excluded", platforms: [], reason: "no credential separation: vendor CLI reads the API key from the agent environment" });
  });

  test("no workflow step or job exposes vendor API keys", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const value of Object.values(job.env ?? {})) expect(value).not.toContain("secrets.");
      for (const step of steps(job)) {
        expect(step.env?.KIRO_API_KEY).toBeUndefined();
        expect(step.env?.CURSOR_API_KEY).toBeUndefined();
        expect(JSON.stringify(step)).not.toMatch(/secrets\.(?:KIRO_API_KEY|CURSOR_API_KEY)/);
      }
    }
  });

  test("every source-executing job depends on the authorized plan", () => {
    const plan = workflow.jobs.plan;
    const authorization = steps(plan).find((step) => step.name === "Resolve immutable source")!;
    expect(steps(plan)[0].with?.["fetch-depth"]).toBe(0);
    expect(authorization.run).toContain("git fetch --no-tags origin main");
    expect(authorization.run).toContain('git merge-base --is-ancestor "$sha" origin/main');
    expect(steps(plan).indexOf(authorization)).toBeLessThan(steps(plan).findIndex((step) => step.run?.includes("bun install")));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "plan") continue;
      expect(Array.isArray(job.needs) ? job.needs : [job.needs], name).toContain("plan");
    }
    expect(workflow.jobs.native_reconcile.if).toContain("needs.plan.result == 'success'");
    for (const step of steps(workflow.jobs.result)) {
      if (step.with?.ref || step.uses?.startsWith("oven-sh/setup-bun@") || step.run?.includes("git rev-parse") || step.run?.includes("bun scripts/")) {
        expect(step.if).toBe(`\${{ needs.plan.result == 'success' }}`);
      }
    }
  });

  test("verification modes are manual-only and each omits its fixed complementary jobs", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(["ref"]);
    expect(workflow.on.workflow_dispatch.inputs.live_verification).toEqual({
      description: "Run only live coverage for this workflow head; evidence cannot qualify for release",
      type: "boolean", default: false,
    });
    expect(workflow.on.workflow_dispatch.inputs.full_verification).toMatchObject({ type: "boolean", default: false });
    expect(workflow.on.workflow_dispatch.inputs.verification_family).toMatchObject({
      type: "choice", required: true, default: "all", options: [...VERIFICATION_FAMILIES],
    });
    expect(workflow.on.workflow_dispatch.inputs.verification_test).toMatchObject({ type: "string", default: "" });
    expect(workflow.jobs.plan.outputs?.verification_test).toBe(`\${{ steps.source.outputs.verification_test }}`);
    expect(workflow.jobs.plan.outputs?.verification_family).toBe(`\${{ steps.source.outputs.verification_family }}`);
    expect(workflow.jobs.plan.outputs?.purpose).toBe(`\${{ steps.source.outputs.purpose }}`);
    expect(steps(workflow.jobs.plan).find((step) => step.id === "source")?.env?.LIVE_VERIFICATION)
      .toBe(`\${{ inputs.live_verification == true }}`);
    expect(steps(workflow.jobs.plan).find((step) => step.id === "source")?.env?.FULL_VERIFICATION)
      .toBe(`\${{ inputs.full_verification == true }}`);
    expect(steps(workflow.jobs.plan).find((step) => step.id === "source")?.env?.VERIFICATION_TEST)
      .toBe(`\${{ inputs.verification_test || '' }}`);
    for (const job of LIVE_VERIFICATION_OMITTED_JOBS) {
      expect(workflow.jobs[job].if, job).toContain("needs.plan.outputs.purpose != 'live-verification'");
    }
    expect(workflow.jobs.live_prepare.if).toBe("needs.plan.outputs.purpose != 'full-verification'");
    for (const kind of ["hosted", "windows"] as const) {
      expect(workflow.jobs[`live_${kind}`].if)
        .toBe(`needs.plan.outputs.purpose != 'full-verification' && needs.plan.outputs.live_${kind}_required == 'true'`);
      expect(workflow.jobs.plan.outputs?.[`live_${kind}_required`]).toBe(`\${{ steps.live_matrix.outputs.${kind}_required }}`);
    }
    expect(workflow.jobs.live_prepare.strategy?.matrix).toBe(`\${{ fromJSON(needs.plan.outputs.live_prepare_matrix) }}`);
    expect(workflow.jobs.release_contract_windows.if).toBe("needs.plan.outputs.verification_family == 'all'");
    for (const step of steps(workflow.jobs.plan).filter((step) =>
      step.run?.includes("reconcile-tests.ts") || step.with?.name === "full-suite-native-plan")) {
      expect(step.if).toBe("steps.source.outputs.purpose != 'live-verification'");
    }
    expect(steps(workflow.jobs.result).find((step) => step.name === "Require every declared leg")?.env?.FULL_SUITE_PURPOSE)
      .toBe(`\${{ needs.plan.outputs.purpose }}`);
    expect(steps(workflow.jobs.result).find((step) => step.name === "Require every declared leg")?.env?.FULL_SUITE_VERIFICATION_FAMILY)
      .toBe(`\${{ needs.plan.outputs.verification_family }}`);
    expect(steps(workflow.jobs.result).find((step) => step.name === "Require every declared leg")?.env?.FULL_SUITE_VERIFICATION_TEST)
      .toBe(`\${{ needs.plan.outputs.verification_test }}`);
    for (const [purpose, artifact] of [
      ["release", "full-suite-result"],
      ["live-verification", "full-suite-live-verification-result"],
      ["full-verification", "full-suite-verification-result"],
    ] as const) {
      const outputs = {
        purpose, verification_family: "all", verification_test: "",
        live_hosted_required: "true", live_windows_required: "true",
      };
      const evaluate = (value: string): unknown => new Function("needs", "steps", "always",
        `return (${value.match(/^\$\{\{([\s\S]+)\}\}$/)?.[1] ?? value});`)(
        { plan: { result: "success", outputs } }, { source: { outputs } }, () => true,
      );
      expect(evaluate(steps(workflow.jobs.result).at(-1)?.with?.name as string), purpose).toBe(artifact);
      for (const job of FULL_SUITE_JOBS.filter((name) => name !== "plan")) {
        const omitted = (purpose === "live-verification" && (LIVE_VERIFICATION_OMITTED_JOBS as readonly string[]).includes(job)) ||
          (purpose === "full-verification" && (FULL_VERIFICATION_OMITTED_JOBS as readonly string[]).includes(job));
        expect(evaluate(workflow.jobs[job].if ?? "true"), `${purpose}/${job}`).toBe(!omitted);
      }
      const nativePlan = steps(workflow.jobs.plan).filter((step) =>
        step.run?.includes("reconcile-tests.ts") || step.with?.name === "full-suite-native-plan");
      expect(nativePlan).toHaveLength(2);
      for (const step of nativePlan) expect(evaluate(step.if!), purpose).toBe(purpose !== "live-verification");
    }
  });

  test("manual verification binds both modes to the workflow head and rejects mixed or filtered full mode", () => {
    const source = steps(workflow.jobs.plan).find((step) => step.id === "source")!;
    const root = mkdtempSync(join(tmpdir(), "t345-verification-source-"));
    // Run the checked-in authorization script with deterministic git responses;
    // no repository mutation, network call or downstream source execution.
    const git = [
      'git() {',
      '  printf "%s\\n" "$*" >> "$FIXTURE_GIT_CALLS"',
      '  case "$1" in',
      '    rev-parse) printf "%s\\n" "$FIXTURE_SHA" ;;',
      '    fetch) return 0 ;;',
      '    merge-base) return "$FIXTURE_ANCESTOR" ;;',
      '    *) return 2 ;;',
      '  esac',
      '}',
    ].join("\n");
    const run = (extra: NodeJS.ProcessEnv) => {
      writeFileSync(join(root, "output"), "");
      writeFileSync(join(root, "git-calls"), "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${git}\n${source.run!}`], {
        cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
        env: {
          ...process.env, LIVE_VERIFICATION: "false", FULL_VERIFICATION: "false",
          VERIFICATION_FAMILY: "all", VERIFICATION_TEST: "", FIXTURE_SHA: identity.sha,
          FIXTURE_ANCESTOR: "1", FIXTURE_GIT_CALLS: "git-calls",
          GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: identity.sha, GITHUB_OUTPUT: "output",
          ...extra,
        },
      });
      return { ...result, output: readFileSync(join(root, "output"), "utf8"), calls: readFileSync(join(root, "git-calls"), "utf8") };
    };
    try {
      for (const [flag, purpose] of [["LIVE_VERIFICATION", "live-verification"], ["FULL_VERIFICATION", "full-verification"]] as const) {
        // Unmerged PRs and main heads both retain their manual verification purpose.
        for (const ancestor of ["0", "1"]) {
          const result = run({ [flag]: "true", FIXTURE_ANCESTOR: ancestor });
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(result.output).toBe(`sha=${identity.sha}\npurpose=${purpose}\nverification_family=all\nverification_test=\n`);
          expect(result.calls).toBe("rev-parse HEAD\n");
        }
        for (const event of ["workflow_call", "schedule", "pull_request", "push"]) {
          const result = run({ [flag]: "true", GITHUB_EVENT_NAME: event });
          expect(result.status, `${purpose}/${event}: ${result.stdout}${result.stderr}`).toBe(1);
          expect(result.output).toBe("");
          expect(result.stdout).toContain("verification requires workflow_dispatch and source equal to the selected workflow head");
          expect(result.calls).toBe("rev-parse HEAD\n");
        }
        const mismatch = run({ [flag]: "true", GITHUB_SHA: "b".repeat(40), FIXTURE_ANCESTOR: "0" });
        expect(mismatch.status, mismatch.stdout + mismatch.stderr).toBe(1);
        expect(mismatch.output).toBe("");
        expect(mismatch.calls).toBe("rev-parse HEAD\n");
      }
      for (const extra of [
        {},
        { VERIFICATION_FAMILY: "codex" },
        { VERIFICATION_FAMILY: "unknown", VERIFICATION_TEST: "invalid" },
      ]) {
        const result = run({ LIVE_VERIFICATION: "true", FULL_VERIFICATION: "true", ...extra });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout).toContain("live_verification and full_verification are mutually exclusive");
        expect(result.output).toBe("");
        expect(result.calls).toBe("rev-parse HEAD\n");
      }
      for (const [live, full] of [["1", "false"], ["false", "1"], ["true", "1"], ["1", "true"]]) {
        const result = run({ LIVE_VERIFICATION: live, FULL_VERIFICATION: full });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout).toContain("invalid verification mode");
        expect(result.output).toBe("");
      }
      for (const extra of [
        ...VERIFICATION_FAMILIES.filter((family) => family !== "all").map((family) => ({ VERIFICATION_FAMILY: family })),
        ...["", "unknown", "release-contract"].map((family) => ({ VERIFICATION_FAMILY: family })),
        { VERIFICATION_TEST: "tests/e2e/t-exec-codex-status.serial.test.ts" },
        { VERIFICATION_FAMILY: "codex", VERIFICATION_TEST: "tests/e2e/t-exec-codex-status.serial.test.ts" },
        { VERIFICATION_TEST: "tests/e2e/*.test.ts" },
      ]) {
        const result = run({ FULL_VERIFICATION: "true", ...extra });
        expect(result.status, `${JSON.stringify(extra)}: ${result.stdout}${result.stderr}`).toBe(1);
        expect(result.output).toBe("");
        expect(result.calls).toBe("rev-parse HEAD\n");
      }
      for (const event of ["workflow_call", "workflow_dispatch", "schedule"]) {
        for (const ancestor of ["0", "1"]) {
          const result = run({ GITHUB_EVENT_NAME: event, GITHUB_SHA: "b".repeat(40), FIXTURE_ANCESTOR: ancestor });
          expect(result.status, result.stdout + result.stderr).toBe(Number(ancestor));
          expect(result.output).toBe(ancestor === "0" ? `sha=${identity.sha}\npurpose=release\nverification_family=all\nverification_test=\n` : "");
          expect(result.calls).toContain("fetch --no-tags origin main\n");
          expect(result.calls).toContain(`merge-base --is-ancestor ${identity.sha} origin/main\n`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const [family, spec] of Object.entries(FAMILIES)) {
    for (const platform of spec.platforms) {
      test(`${family}/${platform} arguments select only populated tiers and produce the exact e2e plan`, () => {
        const args = liveRunnerArgs(family as LiveFamily, platform);
        const selected = classifyLiveFiles(REPO_ROOT).get(family as LiveFamily)!
          .filter((file) => !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform));
        const tiers = new Set(selected.map((file) => file.startsWith("plugins/") ? "integration" : file.split("/")[1]));
        for (const tier of ["unit", "integration", "e2e"]) {
          expect(args.includes(`--${tier}`)).toBe(tiers.has(tier));
        }
        expect(args.includes("--require-coverage")).toBe(spec.requireCoverage);
        expect(args.at(-2)).toBe("--filter");
        const regex = new RegExp(args.at(-1)!);
        expect([...discoverLiveFiles(REPO_ROOT).keys()].filter((file) => aliases(file).some((alias) => regex.test(alias))).sort()).toEqual(selected);
        expect(liveRunnerCommand(family as LiveFamily, platform, [])).toEqual([join(REPO_ROOT, "tests/run-tests.ts"), ...args]);
        const passthrough = ["--debug", "-P", "4"];
        expect(liveRunnerCommand(family as LiveFamily, platform, passthrough)).toEqual([join(REPO_ROOT, "tests/run-tests.ts"), ...passthrough, ...args]);
        const result = spawnSync(process.execPath, [
          join(REPO_ROOT, "scripts/ci-live-filter.ts"), family, "--platform", platform, "--run", "--", "--e2e-plan",
        ], { cwd: tmpdir(), encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
        if (args.includes("--e2e")) {
          expect(args).toContain("--isolated-e2e");
          expect(args[args.indexOf("--bedrock-parallel") + 1]).toBe("2");
          expect(args[args.indexOf("--e2e-file-timeout") + 1]).toBe("3600");
          expect(args).not.toContain("--kiro-parallel");
          expect(args).not.toContain("--ide-parallel");
          expect(result.status, result.stdout + result.stderr).toBe(0);
          const plan = JSON.parse(result.stdout) as { files: Array<{ file: string }> };
          expect(plan.files.map(({ file }) => file).sort()).toEqual(selected.filter((file) => file.startsWith("tests/e2e/")));
        } else {
          for (const flag of ["--isolated-e2e", "--bedrock-parallel", "--kiro-parallel", "--ide-parallel"]) {
            expect(args).not.toContain(flag);
          }
          expect(result.status).toBe(2);
          expect(result.stdout).toBe("");
        }
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }

  test("native obligations include macOS and the fail-closed result depends on every job", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, Job>;
    };
    expect(matrixOf(workflow.jobs.native_terminal).include).toContainEqual({ job: "darwin-bun", runner: "macos-15", backend: "bun" });
    expect(workflow.jobs.result.if).toBe(`\${{ always() }}`);
    expect([...(workflow.jobs.result.needs as string[])].sort()).toEqual(Object.keys(workflow.jobs).filter((name) => name !== "result").sort());
    expect(Object.keys(workflow.jobs).filter((name) => name !== "result").sort()).toEqual([...FULL_SUITE_JOBS].sort());
    const native = steps(workflow.jobs.native_terminal).find((step) => step.name === "Run exact native obligations")!.run!;
    expect(native).toContain("bash tests/run-tests.sh --debug -P 8");
    expect(native).toContain('--filter "$TEST_MATRIX_FILTER" --matrix-plan "$RUNNER_TEMP/native-plan.json"');
    expect(native).toContain(`--matrix-job "\${{ matrix.job }}"`);
    expect(native).toContain('> "$capture/run.log" 2>&1');
    expect(native).toContain("p;q;}");
    const production = steps(workflow.jobs.production_guards).find((step) => step.name === "Require production guard coverage")!.run!;
    expect(production).toContain("--production-guards");
    expect(production).toContain("--require-coverage");
    expect(production).toContain("t-guard-recovery-production");
    // All non-live execution paths use the same generous hierarchy, including
    // ordinary CI and manual native probes. Collection runs outside the step.
    for (const [job, stepName] of [
      [workflow.jobs.native_terminal, "Run exact native obligations"],
      [workflow.jobs.production_guards, "Require production guard coverage"],
      [ci.jobs.test_native_terminal, "Run native terminal contracts"],
      [ci.jobs.test_native_terminal, "Run Windows node-pty compatibility on manual dispatch"],
      [ci.jobs.test_guards, "Exercise recovery with production guards"],
      [deterministic.jobs.test, "Run deterministic tier"],
    ] as const) {
      const execution = steps(job).find((step) => step.name === stepName)!;
      expect(job["timeout-minutes"], stepName).toBe(300);
      expect(execution["timeout-minutes"], stepName).toBe(270);
      expect(execution.run, stepName).toContain("--file-timeout 7200 --run-timeout 14400");
    }
    expect(steps(workflow.jobs.result).at(-1)?.with).toMatchObject({ "if-no-files-found": "error" });
    for (const job of [...Object.values(workflow.jobs), ...Object.values(deterministic.jobs)]) {
      for (const ref of [job.uses, ...steps(job).map((step) => step.uses)].filter((ref): ref is string => !!ref)) {
        expect(ref.startsWith("./") || /^[^@\s]+@[a-f0-9]{40}$/.test(ref), ref).toBe(true);
      }
    }
  });

  test("nightly unit shards cover every unit file exactly once on each supported OS", () => {
    const job = workflow.jobs.deterministic;
    const matrix = matrixOf(job);
    expect(matrix.runner).toEqual(["ubuntu-latest", "macos-15", "windows-latest"]);
    const suites = matrix.suite!;
    expect(suites.filter((suite) => suite.tier === "smoke")).toHaveLength(1);
    expect(suites.filter((suite) => suite.tier === "integration")).toEqual([{ name: "integration", tier: "integration" }]);
    expect(suites.filter((suite) => suite.tier === "e2e")).toEqual([{ name: "e2e", tier: "e2e" }]);
    expect(suites.some((suite) => suite.tier === "deep")).toBe(false);
    expect(new Set(suites.map((suite) => suite.name)).size).toBe(suites.length);
    const shards = suites.filter((suite) => suite.tier === "unit");
    expect(shards.map((suite) => suite.shard)).toEqual(Array.from({ length: 8 }, (_, index) => `${index + 1}/8`));
    const files = readdirSync(join(REPO_ROOT, "tests/unit")).filter((file) => file.endsWith(".test.ts")).sort();
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "tests/unit-shard-weights.json"), "utf8")) as ShardConfig;
    const assignments = shards.map((suite) => selectShard(files, parseShardSpec(suite.shard!), config));
    expect(assignments.every((files) => files.length > 0)).toBe(true);
    expect(assignments.flat().sort()).toEqual(files);
    expect(job.with?.["unit-shard"]).toBe(`\${{ matrix.suite.shard || '' }}`);
    expect(job.with?.["artifact-label"]).toBe(`full-suite-deterministic-\${{ matrix.suite.name }}`);
  });

  test("discovery forms a disjoint partition with exact runner-alias filters", () => {
    const partition = classifyLiveFiles(REPO_ROOT);
    const discovered = [...discoverLiveFiles(REPO_ROOT).keys()].sort();
    const flattened = [...partition.values()].flat();
    expect(flattened.sort()).toEqual(discovered);
    expect(new Set(flattened).size).toBe(flattened.length);
    for (const { file } of discoverClaudeRequiredTests()) expect(flattened).toContain(file);
    expect(partition.get("claude-sdk")).toContain("tests/integration/t300-plugin-kit.test.ts");
    expect(Object.keys(FAMILIES)).not.toContain("multi-provider");
    expect(FAMILIES["claude-sdk"].requireCoverage).toBe(true);
    expect(partition.get("claude-tui")).toContain("tests/integration/t-e2e-isolated-runner.test.ts");
    expect(flattened).not.toContain("tests/unit/t-e2e-plan.test.ts");
    expect(flattened).not.toContain("tests/unit/t-test-matrix.test.ts");
    for (const files of partition.values()) {
      const regex = new RegExp(liveFilter(files));
      expect(discovered.filter((file) => aliases(file).some((alias) => regex.test(alias))).sort()).toEqual(files);
      expect(regex.test("e2e-unrelated-test")).toBe(false);
    }
  });

  test("platform filters preserve portable files and require separately owned Windows controls", () => {
    for (const [file, platforms] of Object.entries(PLATFORM_ONLY)) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
      for (const platform of ["linux", "darwin", "win32"] as const) {
        const regex = new RegExp(liveFilter([file], platform));
        expect(aliases(file).some((alias) => regex.test(alias)), `${file}/${platform}`).toBe(platforms.includes(platform));
      }
    }
    const portable = "tests/e2e/t-tui-journey-orientation.serial.test.ts";
    expect(new RegExp(liveFilter([portable], "linux")).test(aliases(portable)[2])).toBe(true);
    const windows = "tests/e2e/t-tui-journey-orientation-windows.serial.test.ts";
    expect(PLATFORM_ONLY[windows]).toEqual(["win32"]);
    const orientation = discoverClaudeRequiredTests().filter(({ file }) => file === portable || file === windows);
    expect(orientation).toEqual([
      { file: windows, dependencies: ["tui"] },
      { file: portable, dependencies: ["tui"] },
    ]);
  });

  test("plugin helpers do not claim providers beyond each test file's own opt-ins", () => {
    const root = mkdtempSync(join(tmpdir(), "full-suite-discovery-"));
    const put = (file: string, code: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), code);
    };
    try {
      const gate = (family: LiveFamily) => Object.keys(FAMILIES[family].env)[0];
      put("tests/e2e/t-new.test.ts", `const enabled = process.env.${gate("kiro-tui")}; const shared = process.env.${gate("claude-tui")};`);
      put("tests/integration/t-new.test.ts", `const enabled = process.env.${gate("codex")};`);
      put("tests/unit/t-fixture.test.ts", `const fixture = "process.env.${gate("kiro-ide")}";`);
      put("tests/unit/t-release.test.ts", `const enabled = process.env.${gate("release-contract")};`);
      put("plugins/new/tests/plugin.test.ts", `const enabled = process.env.${gate("claude-sdk")}; invokeHarness(project, "claude", "status");`);
      put("plugins/new/tests/gate-contract.test.ts", 'liveGateFor(harness); invokeHarness(project, harness, "status");');
      const partition = classifyLiveFiles(root);
      expect(partition.get("kiro-tui")).toEqual(["tests/e2e/t-new.test.ts"]);
      expect(partition.get("codex")).toEqual(["tests/integration/t-new.test.ts"]);
      expect(partition.get("claude-sdk")).toEqual(["plugins/new/tests/plugin.test.ts"]);
      expect([...partition.values()].flat()).not.toContain("plugins/new/tests/gate-contract.test.ts");
      expect(partition.get("release-contract")).toEqual(["tests/unit/t-release.test.ts"]);
      expect([...partition.values()].flat()).not.toContain("tests/unit/t-fixture.test.ts");
      const regex = new RegExp(liveFilter(partition.get("codex")!));
      expect(regex.test("integration-t-new")).toBe(true);
      expect(regex.test("e2e-t-new")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI emits executable filters and rejects invalid family/platform arguments", () => {
    const script = join(REPO_ROOT, "scripts/ci-live-filter.ts");
    const result = spawnSync(process.execPath, [script, "claude-tui", "--platform", "linux"], {
      encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(result.status, result.stderr).toBe(0);
    const regex = new RegExp(result.stdout.trim());
    expect(regex.test("e2e-t-tui-journey-orientation.serial")).toBe(true);
    expect(regex.test("e2e-t-tui-journey-orientation-windows.serial")).toBe(false);
    const emitted = spawnSync(process.execPath, [script, "release-contract", "--platform", "linux", "--args"], {
      encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(emitted.status, emitted.stderr).toBe(0);
    expect(emitted.stdout.trim().split("\n")).toEqual(liveRunnerArgs("release-contract", "linux"));
    for (const args of [["missing"], ["claude-tui", "--platform", "other"], ["copilot", "--run", "--", "--e2e-plan"], ["codex", "--args", "--run"]]) {
      expect(spawnSync(process.execPath, [script, ...args], { timeout: NATIVE_STARTUP_TIMEOUT_MS }).status).toBe(2);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("skipped live lanes block readiness even when every other job passes", () => {
    const needs = { ...allSuccess(), live_prepare: { result: "skipped" as const }, live_hosted: { result: "skipped" as const }, live_windows: { result: "skipped" as const } };
    expect(fullSuiteResult(needs, identity)).toMatchObject({
      coveragePolicy: FULL_SUITE_COVERAGE_POLICY,
      passed: false, complete: false, disabledLegs: [], excluded: excludedFamilies,
      legs: { live_prepare: "skipped", live_hosted: "skipped", live_windows: "skipped" },
    });
  });

  for (const purpose of ["release"] as const) {
    test(`${purpose} requires hosted live lanes and every other declared job to succeed`, () => {
      const report = fullSuiteResult(allSuccess(), identity, purpose);
      expect(report).toMatchObject({
        ...identity, coveragePolicy: FULL_SUITE_COVERAGE_POLICY,
        purpose, verificationFamily: "all", passed: true, complete: false, disabledLegs: [], omittedLegs: [], excluded: excludedFamilies,
        legs: Object.fromEntries(FULL_SUITE_JOBS.map((job) => [job, "success"])),
      });
      expect(report.verificationTest).toBeUndefined();
      expect(report.verificationPlatforms).toBeUndefined();
      for (const job of FULL_SUITE_JOBS) {
        for (const status of ["failure", "cancelled", "skipped"] as const) {
          expect(fullSuiteResult({ ...allSuccess(), [job]: { result: status } }, identity, purpose), `${job}=${status}`)
            .toMatchObject({ passed: false, complete: false, legs: { [job]: status }, disabledLegs: [], omittedLegs: [] });
        }
        const missing = allSuccess();
        delete missing[job];
        expect(fullSuiteResult(missing, identity, purpose), job)
          .toMatchObject({ passed: false, complete: false, legs: { [job]: "missing" }, disabledLegs: [], omittedLegs: [] });
      }
      expect(fullSuiteResult({ ...allSuccess(), future_job: { result: "skipped" } }, identity, purpose))
        .toMatchObject({ passed: false, complete: false });
      expect(fullSuiteResult(allSuccess(), { ...identity, sha: "main" }, purpose)).toMatchObject({ passed: false, complete: false });
      expect(fullSuiteResult(verificationNeeds(), identity, purpose)).toMatchObject({ passed: false, omittedLegs: [], disabledLegs: [] });
    });
  }

  test("full verification requires every credential-free job and never a credentialed one", () => {
    const report = fullSuiteResult(fullVerificationNeeds(), identity, "full-verification");
    expect(report).toMatchObject({
      ...identity, coveragePolicy: FULL_SUITE_COVERAGE_POLICY, purpose: "full-verification", verificationFamily: "all",
      passed: true, complete: false, disabledLegs: [], omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], excluded: excludedFamilies,
    });
    for (const job of FULL_SUITE_JOBS) {
      const omitted = (FULL_VERIFICATION_OMITTED_JOBS as readonly string[]).includes(job);
      // A credentialed lane that ran, or a required job with any outcome but success, fails the evidence.
      const statuses = omitted ? ["success", "failure", "cancelled"] as const : ["failure", "cancelled", "skipped"] as const;
      for (const status of statuses) {
        expect(fullSuiteResult({ ...fullVerificationNeeds(), [job]: { result: status } }, identity, "full-verification"), `${job}=${status}`)
          .toMatchObject({ passed: false, complete: false });
      }
      const missing = fullVerificationNeeds();
      delete missing[job];
      expect(fullSuiteResult(missing, identity, "full-verification"), job).toMatchObject({ passed: false, legs: { [job]: "missing" } });
    }
    expect(fullSuiteResult(allSuccess(), identity, "full-verification")).toMatchObject({ passed: false });
    expect(fullSuiteResult(verificationNeeds(), identity, "full-verification")).toMatchObject({ passed: false });
  });

  test("full verification cannot reach a credentialed job, and no candidate checkout persists credentials", () => {
    const oidcJobs = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.["id-token"] === "write").map(([name]) => name);
    expect(oidcJobs.length).toBeGreaterThan(0);
    const outputs = { purpose: "full-verification", verification_family: "all", verification_test: "", live_hosted_required: "true", live_windows_required: "true" };
    const evaluate = (value: string): unknown => new Function("needs", `return (${value});`)({ plan: { result: "success", outputs } });
    for (const name of [...oidcJobs, "live_prepare"]) {
      expect(evaluate(workflow.jobs[name].if ?? "true"), name).toBe(false);
      expect((FULL_VERIFICATION_OMITTED_JOBS as readonly string[]).includes(name), name).toBe(true);
    }
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of steps(job).filter((step) => step.uses?.startsWith("actions/checkout@"))) {
        expect(step.with?.["persist-credentials"], name).toBe(false);
      }
    }
  });

  test("full verification rejects family and exact-test filters even when all jobs succeed", () => {
    for (const family of [...VERIFICATION_FAMILIES.filter((value) => value !== "all"), "", "unknown", "release-contract"]) {
      expect(fullSuiteResult(fullVerificationNeeds(), identity, "full-verification", family as VerificationFamily), family)
        .toMatchObject({ passed: false, complete: false, omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], disabledLegs: [] });
    }
    for (const family of VERIFICATION_FAMILIES) {
      for (const selected of ["tests/integration/t238-user-stories-mob.sdk.test.ts", "tests/e2e/*.test.ts", " "]) {
        expect(fullSuiteResult(fullVerificationNeeds(), identity, "full-verification", family, selected), `${family}/${selected}`)
          .toMatchObject({ passed: false, complete: false, verificationTest: selected, omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], disabledLegs: [] });
      }
    }
  });

  test("unknown runtime purposes cannot produce passing evidence", () => {
    for (const purpose of ["", "unknown", "full_verification", "release\n"]) {
      expect(fullSuiteResult(allSuccess(), identity, purpose as SuitePurpose), JSON.stringify(purpose))
        .toMatchObject({ passed: false, complete: false });
    }
  });

  test("verification passes only with successful live jobs and exactly skipped omissions", () => {
    expect(fullSuiteResult(verificationNeeds(), identity, "live-verification")).toMatchObject({
      ...identity, purpose: "live-verification", verificationFamily: "all", passed: true, complete: false,
      omittedLegs: [...LIVE_VERIFICATION_OMITTED_JOBS], disabledLegs: [], excluded: excludedFamilies,
    });
    expect(fullSuiteResult(verificationNeeds(), identity)).toMatchObject({ purpose: "release", passed: false });
    for (const job of FULL_SUITE_JOBS) {
      const omitted = (LIVE_VERIFICATION_OMITTED_JOBS as readonly string[]).includes(job);
      for (const result of omitted ? ["success", "failure", "cancelled"] as const : ["skipped", "failure", "cancelled"] as const) {
        const needs = verificationNeeds();
        needs[job] = { result };
        expect(fullSuiteResult(needs, identity, "live-verification").passed, `${job}=${result}`).toBe(false);
      }
      const needs = verificationNeeds();
      delete needs[job];
      expect(fullSuiteResult(needs, identity, "live-verification")).toMatchObject({ passed: false, legs: { [job]: "missing" } });
    }
  });

  test("family verification omits Windows release contracts and cannot qualify as release evidence", () => {
    for (const family of VERIFICATION_FAMILIES.filter((value) => value !== "all")) {
      const needs = verificationNeeds(family);
      expect(fullSuiteResult(needs, identity, "live-verification", family)).toMatchObject({
        purpose: "live-verification", verificationFamily: family, passed: true, complete: false,
        omittedLegs: [...LIVE_VERIFICATION_OMITTED_JOBS, "release_contract_windows"],
      });
      expect(fullSuiteResult(allSuccess(), identity, "release", family).passed).toBe(false);
      for (const result of ["success", "failure", "cancelled"] as const) {
        expect(fullSuiteResult({ ...needs, release_contract_windows: { result } }, identity, "live-verification", family).passed).toBe(false);
      }
      delete needs.release_contract_windows;
      expect(fullSuiteResult(needs, identity, "live-verification", family)).toMatchObject({
        passed: false, legs: { release_contract_windows: "missing" },
      });
    }
    for (const family of ["", "release-contract", "unknown"]) {
      expect(fullSuiteResult(allSuccess(), identity, "live-verification", family as VerificationFamily).passed).toBe(false);
    }
  });

  test("exact-file results identify their selection and cannot qualify as release evidence", () => {
    const file = "tests/integration/t238-user-stories-mob.sdk.test.ts";
    expect(fullSuiteResult(verificationNeeds("claude-sdk"), identity, "live-verification", "claude-sdk", file))
      .toMatchObject({ passed: true, complete: false, verificationTest: file, verificationFamily: "claude-sdk",
        verificationPlatforms: ["linux", "darwin", "win32"] });
    expect(fullSuiteResult(allSuccess(), identity, "release", "all", file).passed).toBe(false);
    expect(fullSuiteResult(verificationNeeds(), identity, "live-verification", "all", file).passed).toBe(false);
    expect(fullSuiteResult(verificationNeeds("codex"), identity, "live-verification", "codex", file).passed).toBe(false);
    expect(fullSuiteResult(verificationNeeds("claude-sdk"), identity, "live-verification", "claude-sdk",
      "tests/integration/missing.test.ts").passed).toBe(false);
    const windowsFile = "tests/e2e/t-tui-windows-user-settings-isolation.serial.test.ts";
    const windowsNeeds = { ...verificationNeeds("claude-tui"), live_hosted: { result: "skipped" as const } };
    expect(fullSuiteResult(windowsNeeds, identity, "live-verification", "claude-tui", windowsFile))
      .toMatchObject({ passed: true, complete: false, verificationPlatforms: ["win32"],
        omittedLegs: [...LIVE_VERIFICATION_OMITTED_JOBS, "release_contract_windows", "live_hosted"] });
    expect(fullSuiteResult(verificationNeeds("claude-tui"), identity, "live-verification", "claude-tui", windowsFile).passed).toBe(false);
    expect(fullSuiteResult({ ...windowsNeeds, live_windows: { result: "skipped" } },
      identity, "live-verification", "claude-tui", windowsFile).passed).toBe(false);
  });

  test("result CLI fails skipped lanes, retains diagnostics, and accepts required jobs with explicit exclusions", () => {
    const root = mkdtempSync(join(tmpdir(), "full-suite-result-"));
    try {
      const needs: SuiteNeeds = { ...allSuccess(), live_prepare: { result: "skipped" }, live_hosted: { result: "skipped" }, live_windows: { result: "skipped" } };
      const env = {
        ...process.env, FULL_SUITE_PURPOSE: "release", FULL_SUITE_VERIFICATION_FAMILY: "all",
        FULL_SUITE_VERIFICATION_TEST: "",
        FULL_SUITE_NEEDS: JSON.stringify(needs), FULL_SUITE_SHA: identity.sha,
      };
      const output = join(root, "result.json");
      const script = join(REPO_ROOT, "scripts/ci-full-suite-result.ts");
      const result = spawnSync(process.execPath, [script, output], { encoding: "utf8", env, timeout: NATIVE_STARTUP_TIMEOUT_MS });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`::error::Incomplete full suite for ${identity.sha}`);
      expect(result.stderr).toContain("live_hosted=skipped");
      expect(result.stderr).toContain(`::warning::Full suite excluded families: ${excludedFamilies.join(", ")}`);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report).toMatchObject({ coveragePolicy: FULL_SUITE_COVERAGE_POLICY, passed: false, complete: false, disabledLegs: [], excluded: excludedFamilies });
      delete needs.native_reconcile;
      const missing = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS, env: { ...env, FULL_SUITE_NEEDS: JSON.stringify(needs) },
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("native_reconcile=missing");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ passed: false, complete: false, excluded: excludedFamilies });
      const success = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS, env: { ...env, FULL_SUITE_NEEDS: JSON.stringify(allSuccess()) },
      });
      expect(success.status, success.stderr).toBe(0);
      expect(success.stderr).toContain(`::warning::Full suite excluded families: ${excludedFamilies.join(", ")}`);
      expect(success.stderr).not.toContain("::error::");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        coveragePolicy: FULL_SUITE_COVERAGE_POLICY, passed: true, complete: false, disabledLegs: [], excluded: excludedFamilies,
      });
      const verification = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
        env: { ...env, FULL_SUITE_PURPOSE: "live-verification", FULL_SUITE_NEEDS: JSON.stringify(verificationNeeds()) },
      });
      expect(verification.status, verification.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        purpose: "live-verification", passed: true, complete: false, omittedLegs: [...LIVE_VERIFICATION_OMITTED_JOBS],
      });
      const scoped = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
        env: { ...env, FULL_SUITE_PURPOSE: "live-verification", FULL_SUITE_VERIFICATION_FAMILY: "codex", FULL_SUITE_NEEDS: JSON.stringify(verificationNeeds("codex")) },
      });
      expect(scoped.status, scoped.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ verificationFamily: "codex", passed: true, complete: false });
      for (const family of ["", "unknown"]) {
        const invalidFamily = spawnSync(process.execPath, [script, output], {
          encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS, env: { ...env, FULL_SUITE_VERIFICATION_FAMILY: family },
        });
        expect(invalidFamily.status).toBe(1);
        expect(invalidFamily.stderr).toContain("Invalid verification family");
      }
      const invalid = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS, env: { ...env, FULL_SUITE_PURPOSE: "unknown" },
      });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("Invalid full-suite purpose");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("full verification CLI preserves credential-free evidence and rejects extra omissions, filters and invalid purpose", () => {
    const root = mkdtempSync(join(tmpdir(), "full-suite-verification-result-"));
    const output = join(root, "result.json");
    const script = join(REPO_ROOT, "scripts/ci-full-suite-result.ts");
    const run = (extra: NodeJS.ProcessEnv = {}) => {
      rmSync(output, { force: true });
      return spawnSync(process.execPath, [script, output], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
        env: {
          ...process.env, FULL_SUITE_PURPOSE: "full-verification", FULL_SUITE_VERIFICATION_FAMILY: "all",
          FULL_SUITE_VERIFICATION_TEST: "", FULL_SUITE_NEEDS: JSON.stringify(fullVerificationNeeds()), FULL_SUITE_SHA: identity.sha,
          GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.runAttempt, ...extra,
        },
      });
    };
    try {
      const success = run();
      expect(success.status, success.stdout + success.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        ...identity, purpose: "full-verification", verificationFamily: "all",
        coveragePolicy: FULL_SUITE_COVERAGE_POLICY, passed: true, complete: false,
        omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], disabledLegs: [], excluded: excludedFamilies,
        legs: Object.fromEntries(FULL_SUITE_JOBS.map((job) => [
          job, (FULL_VERIFICATION_OMITTED_JOBS as readonly string[]).includes(job) ? "skipped" : "success",
        ])),
      });
      for (const status of ["missing", "failure", "cancelled", "skipped"] as const) {
        const needs = fullVerificationNeeds();
        if (status === "missing") delete needs.release_contract_windows;
        else needs.release_contract_windows = { result: status };
        const result = run({ FULL_SUITE_NEEDS: JSON.stringify(needs) });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(`release_contract_windows=${status}`);
        expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
          purpose: "full-verification", passed: false, complete: false,
          legs: { release_contract_windows: status }, omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], disabledLegs: [],
        });
      }
      const omitted = run({ FULL_SUITE_NEEDS: JSON.stringify(verificationNeeds()) });
      expect(omitted.status, omitted.stderr).toBe(1);
      for (const job of LIVE_VERIFICATION_OMITTED_JOBS) expect(omitted.stderr).toContain(`${job}=skipped`);
      for (const family of VERIFICATION_FAMILIES.filter((value) => value !== "all")) {
        const filtered = run({ FULL_SUITE_VERIFICATION_FAMILY: family });
        expect(filtered.status, filtered.stderr).toBe(1);
        expect(filtered.stderr).toContain("Full verification requires verificationFamily=all");
        expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
          purpose: "full-verification", verificationFamily: family, passed: false, complete: false, omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], disabledLegs: [],
        });
      }
      const selected = "tests/integration/t238-user-stories-mob.sdk.test.ts";
      const filtered = run({ FULL_SUITE_VERIFICATION_TEST: selected });
      expect(filtered.status, filtered.stderr).toBe(1);
      expect(filtered.stderr).toContain("Exact test selection requires live-verification mode and one verification family");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        purpose: "full-verification", verificationTest: selected, passed: false, complete: false, omittedLegs: [...FULL_VERIFICATION_OMITTED_JOBS], disabledLegs: [],
      });
      for (const family of ["", "unknown", "release-contract"]) {
        const invalid = run({ FULL_SUITE_VERIFICATION_FAMILY: family });
        expect(invalid.status, invalid.stderr).toBe(1);
        expect(invalid.stderr).toContain("Invalid verification family");
        expect(existsSync(output)).toBe(false);
      }
      for (const purpose of ["", "unknown", "full_verification"]) {
        const invalid = run({ FULL_SUITE_PURPOSE: purpose });
        expect(invalid.status, invalid.stderr).toBe(1);
        expect(invalid.stderr).toContain("Invalid full-suite purpose");
        expect(existsSync(output)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
