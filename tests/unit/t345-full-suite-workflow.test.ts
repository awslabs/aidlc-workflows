import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyLiveFiles, discoverLiveFiles, FAMILIES, liveFilter, liveMatrix, liveRunnerArgs, liveRunnerCommand, liveRunnerEnvironment, PLATFORM_ONLY, selectedLiveFiles, VERIFICATION_FAMILIES, type LiveFamily, type VerificationFamily } from "../../scripts/ci-live-filter.ts";
import { FULL_SUITE_COVERAGE_POLICY, FULL_SUITE_JOBS, LIVE_VERIFICATION_OMITTED_JOBS, fullSuiteResult, type SuiteNeeds } from "../../scripts/ci-full-suite-result.ts";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";
import { brokerChildEnvironment } from "../../scripts/ci-start-credential-broker.ts";
import { sandboxEnvironment } from "../../scripts/ci-live-sandbox.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { setupCodexProject } from "../harness/exec-drive.ts";
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
  on: { workflow_call: { inputs: Record<string, { type: string; required?: boolean; default?: string }> } };
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
    const passed = Object.fromEntries(Object.keys(aggregate.env!).map((key) => [key, "success"]));
    const run = (env: Record<string, string>) => spawnSync("bash", ["-e", "-c", aggregate.run!], {
      env: { ...process.env, ...env }, encoding: "utf8",
    }).status;
    expect(run(passed)).toBe(0);
    for (const key of Object.keys(passed)) {
      for (const status of ["failure", "cancelled", "skipped"]) {
        expect(run({ ...passed, [key]: status }), `${key}=${status}`).toBe(1);
      }
    }
    expect(aggregate.env?.DETERMINISTIC_RESULT).toBe(`\${{ needs.deterministic.result }}`);
  }, 30_000);

  test("shared deterministic setup binds the checkout and prepares each fresh job without credentials", () => {
    expect(Object.keys(deterministic.on)).toEqual(["workflow_call"]);
    expect(Object.keys(deterministic.on.workflow_call.inputs).sort()).toEqual(["artifact-label", "ref", "runner", "tier", "unit-shard"]);
    expect(deterministic.permissions).toEqual({ contents: "read" });
    const job = deterministic.jobs.test;
    expect(job["runs-on"]).toBe(`\${{ inputs.runner }}`);
    expect(job["timeout-minutes"]).toBe(`\${{ inputs.tier == 'smoke' && 15 || 60 }}`);
    const setup = steps(job);
    expect(setup.find((step) => step.name === "Run deterministic tier")?.["timeout-minutes"])
      .toBe(`\${{ inputs.tier == 'smoke' && 10 || 50 }}`);
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

  test("shared selection rejects mutable refs, unknown tiers and misplaced unit shards", () => {
    const selection = steps(deterministic.jobs.test).find((step) => step.name === "Validate test selection")!;
    const run = (extra: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", selection.run!], {
      encoding: "utf8",
      env: { ...process.env, TEST_REF: identity.sha, TEST_TIER: "unit", UNIT_SHARD: "2/8", ARTIFACT_LABEL: "ci-unit-2", ...extra },
    });
    expect(run({}).status).toBe(0);
    expect(run({ UNIT_SHARD: "1/1" }).status).toBe(0);
    for (const tier of ["smoke", "integration", "e2e"]) {
      expect(run({ TEST_TIER: tier, UNIT_SHARD: "" }).status).toBe(0);
      expect(run({ TEST_TIER: tier }).status).not.toBe(0);
    }
    for (const extra of [{ TEST_REF: "main" }, { TEST_TIER: "unknown" }, { TEST_TIER: "deep", UNIT_SHARD: "" }, { UNIT_SHARD: "" }, { UNIT_SHARD: "9/8" }, { ARTIFACT_LABEL: "../outside" }]) {
      const result = run(extra);
      expect(result.status, `${JSON.stringify(extra)}\n${result.stdout}\n${result.stderr}`).toBe(2);
    }
  }, 30_000);

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
    expect(steps(deterministic.jobs.test).find((step) => step.name === "Run deterministic tier")?.run).not.toContain("--filter");
    const manual = steps(ci.jobs.test_native_terminal).find((step) => step.name === "Run Windows node-pty compatibility on manual dispatch")!;
    expect(manual.if).toBe("github.event_name == 'workflow_dispatch' && inputs.platform_regressions && runner.os == 'Windows'");
    expect(manual.env).toEqual({ AIDLC_TUI_BACKEND: "node-pty" });
    expect(manual.run).toContain("--filter '^t-tui-node-pty-compat$'");
    expect(manual.run).toContain("sed -n '/^Verbose mode: logging to /{s/^Verbose mode: logging to //;p;q;}'");
    expect(steps(ci.jobs.test_native_terminal).some((step) => step.name === "Run platform regressions on manual dispatch")).toBe(false);
  });

  for (const [tier, shard, expected] of [
    ["smoke", "", ["--smoke"]],
    ["unit", "3/8", ["--unit", "--shard", "3/8"]],
    ["integration", "", ["--integration"]],
    ["e2e", "", ["--e2e", "--isolated-e2e", "--e2e-file-timeout", "900"]],
  ] as const) {
    test(`shared ${tier} execution preserves arguments, captured output and failure status`, () => {
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
          'if [ "$OMIT_SUMMARY" != 1 ]; then printf "Test files: 1\\n" > "$stamp/summary.txt"; fi',
          'exit "$FIXTURE_EXIT"',
        ].join("\n"));
        for (const [exit, omit, expectedStatus] of [["0", "0", 0], ["7", "0", 7], ["0", "1", 1]] as const) {
          rmSync(join(root, "tests/logs"), { recursive: true, force: true });
          const result = spawnSync("bash", ["-c", step.run!], {
            cwd: root, encoding: "utf8", timeout: 15_000,
            env: { ...process.env, GITHUB_WORKSPACE: root.replaceAll("\\", "/"), TEST_TIER: tier, UNIT_SHARD: shard, FIXTURE_EXIT: exit, OMIT_SUMMARY: omit },
          });
          expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
          expect(readFileSync(join(root, "argv.bin"), "utf8").split("\0").filter(Boolean))
            .toEqual(["--debug", "-P", "8", "--no-llm", ...expected, "--run-timeout", tier === "smoke" ? "480" : "2700"]);
          expect(readFileSync(join(root, "tmp/ci-deterministic/run.log"), "utf8")).toContain("captured deterministic output");
          expect(readFileSync(join(root, "tmp/ci-deterministic/stamp.txt"), "utf8").trim())
            .toBe(`${root.replaceAll("\\", "/")}/tests/logs/fixture`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
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

  test("authorized full-suite runs always prepare and execute isolated hosted live jobs", () => {
    const jobs = Object.entries(workflow.jobs);
    const oidcJobs = jobs.filter(([, job]) => job.permissions?.["id-token"] === "write").map(([name]) => name).sort();
    expect(oidcJobs).toEqual(["live_hosted", "live_windows"]);
    for (const name of ["live_prepare", ...oidcJobs]) {
      const needs = workflow.jobs[name].needs;
      expect(Array.isArray(needs) ? needs : [needs]).toContain("plan");
    }
    expect(workflow.jobs.live_prepare.if).toBeUndefined();
    for (const kind of ["hosted", "windows"] as const) {
      expect(workflow.jobs[`live_${kind}`].if).toBe(`needs.plan.outputs.live_${kind}_required == 'true'`);
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
          encoding: "utf8",
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
  }, 30_000);

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
      const run = (...args: string[]) => spawnSync(process.platform === "win32" ? "python" : "python3", [script, ...args], { encoding: "utf8" });
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
  }, 30_000);

  test("POSIX collection retires macOS user domains and refuses remaining executable processes", () => {
    const source = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.sh"), "utf8");
    const collect = source.slice(source.indexOf('elif [[ "$mode" == collect ]]'));
    expect(collect.indexOf('sudo launchctl bootout "$domain"')).toBeLessThan(collect.indexOf("sudo pkill"));
    expect(collect).toContain('"gui/$live_uid" "user/$live_uid"');
    expect(collect.indexOf('remaining="$(active_live_processes)"')).toBeLessThan(collect.indexOf('sudo cp -a "$live_root/tests/logs/."'));
    const filter = source.match(/awk -v uid="\$live_uid" '([^']+)'/)![1];
    const result = spawnSync("bash", ["-c", 'awk -v uid=502 "$1"', "collection-filter", filter], {
      encoding: "utf8", input: "501 10 S runner\n502 11 Z zombie\n502 12 Z+ zombie-child\n502 13 S worker\n502 14 R child\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("502 13 S worker\n502 14 R child\n");
  });

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

  test("PR CI exercises the same OS identity boundary without provider credentials", () => {
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

  test("all tests/logs uploads require successful sanitization even after test failure", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const [index, step] of steps(job).entries()) {
        const path = step.with?.path;
        if (!step.uses?.startsWith("actions/upload-artifact@") || typeof path !== "string" || !path.split("\n").includes("tests/logs/")) continue;
        const sanitize = steps(job)[index - 1];
        expect(sanitize).toMatchObject({ id: "sanitize", if: `\${{ always() }}` });
        expect(sanitize.run).toContain("bun scripts/ci-sanitize-logs.ts tests/logs");
        if (path.includes("tmp/full-suite-native/")) expect(sanitize.run).toContain("bun scripts/ci-sanitize-logs.ts tmp/full-suite-native");
        expect(step.if).toBe(`\${{ always() && steps.sanitize.outcome == 'success' }}`);
      }
    }
    const sharedSteps = steps(deterministic.jobs.test);
    const upload = sharedSteps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    const sanitize = sharedSteps.find((step) => step.id === "sanitize")!;
    expect(sanitize.if).toBe(`\${{ always() }}`);
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
  }, 30_000);

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
        expect(run!["timeout-minutes"]).toBe(45);
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
      expect(job["timeout-minutes"]).toBe(55);
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
      ], { encoding: "utf8" });
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
  });

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

  test("live verification is manual-only and omits exactly the non-live jobs", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(["ref"]);
    expect(workflow.on.workflow_dispatch.inputs.live_verification).toEqual({
      description: "Run only live coverage for this workflow head; evidence cannot qualify for release",
      type: "boolean", default: false,
    });
    expect(workflow.on.workflow_dispatch.inputs.verification_family).toMatchObject({
      type: "choice", required: true, default: "all", options: [...VERIFICATION_FAMILIES],
    });
    expect(workflow.on.workflow_dispatch.inputs.verification_test).toMatchObject({ type: "string", default: "" });
    expect(workflow.jobs.plan.outputs?.verification_test).toBe(`\${{ steps.source.outputs.verification_test }}`);
    expect(workflow.jobs.plan.outputs?.verification_family).toBe(`\${{ steps.source.outputs.verification_family }}`);
    expect(workflow.jobs.plan.outputs?.purpose).toBe(`\${{ steps.source.outputs.purpose }}`);
    expect(steps(workflow.jobs.plan).find((step) => step.id === "source")?.env?.LIVE_VERIFICATION)
      .toBe(`\${{ inputs.live_verification == true }}`);
    expect(steps(workflow.jobs.plan).find((step) => step.id === "source")?.env?.VERIFICATION_TEST)
      .toBe(`\${{ inputs.verification_test || '' }}`);
    for (const job of LIVE_VERIFICATION_OMITTED_JOBS) {
      expect(workflow.jobs[job].if, job).toContain("needs.plan.outputs.purpose == 'release'");
    }
    expect(workflow.jobs.live_prepare.if).toBeUndefined();
    for (const kind of ["hosted", "windows"] as const) {
      expect(workflow.jobs[`live_${kind}`].if).toBe(`needs.plan.outputs.live_${kind}_required == 'true'`);
      expect(workflow.jobs.plan.outputs?.[`live_${kind}_required`]).toBe(`\${{ steps.live_matrix.outputs.${kind}_required }}`);
    }
    expect(workflow.jobs.live_prepare.strategy?.matrix).toBe(`\${{ fromJSON(needs.plan.outputs.live_prepare_matrix) }}`);
    expect(workflow.jobs.release_contract_windows.if).toBe("needs.plan.outputs.verification_family == 'all'");
    for (const step of steps(workflow.jobs.plan).filter((step) =>
      step.run?.includes("reconcile-tests.ts") || step.with?.name === "full-suite-native-plan")) {
      expect(step.if).toBe("steps.source.outputs.purpose == 'release'");
    }
    expect(steps(workflow.jobs.result).find((step) => step.name === "Require every declared leg")?.env?.FULL_SUITE_PURPOSE)
      .toBe(`\${{ needs.plan.outputs.purpose }}`);
    expect(steps(workflow.jobs.result).find((step) => step.name === "Require every declared leg")?.env?.FULL_SUITE_VERIFICATION_FAMILY)
      .toBe(`\${{ needs.plan.outputs.verification_family }}`);
    expect(steps(workflow.jobs.result).at(-1)?.with?.name)
      .toBe(`\${{ needs.plan.outputs.purpose == 'live-verification' && 'full-suite-live-verification-result' || 'full-suite-result' }}`);
  });

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
        ], { cwd: tmpdir(), encoding: "utf8", timeout: 15_000 });
        if (args.includes("--e2e")) {
          expect(args).toContain("--isolated-e2e");
          expect(args[args.indexOf("--bedrock-parallel") + 1]).toBe("2");
          expect(args[args.indexOf("--e2e-file-timeout") + 1]).toBe("2400");
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
      }, 30_000);
    }
  }

  test("native obligations include macOS and the fail-closed result depends on every job", () => {
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
    const result = spawnSync(process.execPath, [script, "claude-tui", "--platform", "linux"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const regex = new RegExp(result.stdout.trim());
    expect(regex.test("e2e-t-tui-journey-orientation.serial")).toBe(true);
    expect(regex.test("e2e-t-tui-journey-orientation-windows.serial")).toBe(false);
    const emitted = spawnSync(process.execPath, [script, "release-contract", "--platform", "linux", "--args"], { encoding: "utf8" });
    expect(emitted.status, emitted.stderr).toBe(0);
    expect(emitted.stdout.trim().split("\n")).toEqual(liveRunnerArgs("release-contract", "linux"));
    for (const args of [["missing"], ["claude-tui", "--platform", "other"], ["copilot", "--run", "--", "--e2e-plan"], ["codex", "--args", "--run"]]) {
      expect(spawnSync(process.execPath, [script, ...args]).status).toBe(2);
    }
  });

  test("skipped live lanes block readiness even when every other job passes", () => {
    const needs = { ...allSuccess(), live_prepare: { result: "skipped" as const }, live_hosted: { result: "skipped" as const }, live_windows: { result: "skipped" as const } };
    expect(fullSuiteResult(needs, identity)).toMatchObject({
      coveragePolicy: FULL_SUITE_COVERAGE_POLICY,
      passed: false, complete: false, disabledLegs: [], excluded: excludedFamilies,
      legs: { live_prepare: "skipped", live_hosted: "skipped", live_windows: "skipped" },
    });
  });

  test("hosted live lanes and every other declared job must succeed", () => {
    expect(fullSuiteResult(allSuccess(), identity)).toMatchObject({
      ...identity, coveragePolicy: FULL_SUITE_COVERAGE_POLICY,
      purpose: "release", verificationFamily: "all", passed: true, complete: false, disabledLegs: [], omittedLegs: [], excluded: excludedFamilies,
    });
    for (const job of FULL_SUITE_JOBS) {
      for (const status of ["failure", "cancelled", "skipped"] as const) {
        expect(fullSuiteResult({ ...allSuccess(), [job]: { result: status } }, identity))
          .toMatchObject({ passed: false, complete: false });
      }
      const missing = allSuccess();
      delete missing[job];
      expect(fullSuiteResult(missing, identity)).toMatchObject({ passed: false, complete: false, legs: { [job]: "missing" } });
    }
    expect(fullSuiteResult({ ...allSuccess(), future_job: { result: "skipped" } }, identity))
      .toMatchObject({ passed: false, complete: false });
    expect(fullSuiteResult(allSuccess(), { ...identity, sha: "main" })).toMatchObject({ passed: false, complete: false });
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
        FULL_SUITE_NEEDS: JSON.stringify(needs), FULL_SUITE_SHA: identity.sha,
      };
      const output = join(root, "result.json");
      const script = join(REPO_ROOT, "scripts/ci-full-suite-result.ts");
      const result = spawnSync(process.execPath, [script, output], { encoding: "utf8", env });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`::error::Incomplete full suite for ${identity.sha}`);
      expect(result.stderr).toContain("live_hosted=skipped");
      expect(result.stderr).toContain(`::warning::Full suite excluded families: ${excludedFamilies.join(", ")}`);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report).toMatchObject({ coveragePolicy: FULL_SUITE_COVERAGE_POLICY, passed: false, complete: false, disabledLegs: [], excluded: excludedFamilies });
      delete needs.native_reconcile;
      const missing = spawnSync(process.execPath, [script, output], { encoding: "utf8", env: { ...env, FULL_SUITE_NEEDS: JSON.stringify(needs) } });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("native_reconcile=missing");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ passed: false, complete: false, excluded: excludedFamilies });
      const success = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", env: { ...env, FULL_SUITE_NEEDS: JSON.stringify(allSuccess()) },
      });
      expect(success.status, success.stderr).toBe(0);
      expect(success.stderr).toContain(`::warning::Full suite excluded families: ${excludedFamilies.join(", ")}`);
      expect(success.stderr).not.toContain("::error::");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        coveragePolicy: FULL_SUITE_COVERAGE_POLICY, passed: true, complete: false, disabledLegs: [], excluded: excludedFamilies,
      });
      const verification = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", env: { ...env, FULL_SUITE_PURPOSE: "live-verification", FULL_SUITE_NEEDS: JSON.stringify(verificationNeeds()) },
      });
      expect(verification.status, verification.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        purpose: "live-verification", passed: true, complete: false, omittedLegs: [...LIVE_VERIFICATION_OMITTED_JOBS],
      });
      const scoped = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", env: { ...env, FULL_SUITE_PURPOSE: "live-verification", FULL_SUITE_VERIFICATION_FAMILY: "codex", FULL_SUITE_NEEDS: JSON.stringify(verificationNeeds("codex")) },
      });
      expect(scoped.status, scoped.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ verificationFamily: "codex", passed: true, complete: false });
      for (const family of ["", "unknown"]) {
        const invalidFamily = spawnSync(process.execPath, [script, output], {
          encoding: "utf8", env: { ...env, FULL_SUITE_VERIFICATION_FAMILY: family },
        });
        expect(invalidFamily.status).toBe(1);
        expect(invalidFamily.stderr).toContain("Invalid verification family");
      }
      const invalid = spawnSync(process.execPath, [script, output], {
        encoding: "utf8", env: { ...env, FULL_SUITE_PURPOSE: "unknown" },
      });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("Invalid full-suite purpose");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
