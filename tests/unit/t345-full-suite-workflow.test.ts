import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyLiveFiles, discoverLiveFiles, FAMILIES, liveFilter, liveRunnerArgs, liveRunnerCommand, PLATFORM_ONLY, type LiveFamily } from "../../scripts/ci-live-filter.ts";
import { FULL_SUITE_JOBS, fullSuiteResult, type SuiteNeeds } from "../../scripts/ci-full-suite-result.ts";
import { credentialProcessResponse } from "../../scripts/ci-aws-credential-process.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

interface Step {
  name?: string;
  shell?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  uses?: string;
  "runs-on": string | string[];
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
  strategy?: { matrix: { include?: Array<Record<string, string>>; family?: LiveFamily[] } };
  steps: Step[];
}
const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/full-suite.yml"), "utf8")) as {
  on: { workflow_call: { secrets: Record<string, { required: boolean }> } };
  jobs: Record<string, Job>;
};

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

function rows(job: Job): Array<{ family: LiveFamily; platform: string }> {
  const matrix = job.strategy?.matrix;
  if (matrix?.include) return matrix.include.map((row) => {
    const platform = platformOf(row.runner);
    expect(row.platform).toBe(platform);
    return { family: row.family as LiveFamily, platform };
  });
  return (matrix?.family ?? []).map((family) => ({ family, platform: platformOf(job["runs-on"]) }));
}

function allSuccess(): SuiteNeeds {
  return Object.fromEntries(FULL_SUITE_JOBS.map((job) => [job, { result: "success" as const }]));
}
const identity = { sha: "a".repeat(40), runId: "123", runAttempt: "2" };

describe("t345 complete nightly coverage", () => {
  test("native terminal CI selects only executable platform units across every runner alias", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, Job>;
    };
    const matrix = ci.jobs.test_native_terminal.strategy!.matrix.include!;
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

  test("credential process returns AWS Version 1 credentials without accepting missing inputs", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      AWS_SESSION_TOKEN: "test-session-token",
    };
    const response = { Version: 1 as const, AccessKeyId: env.AWS_ACCESS_KEY_ID, SecretAccessKey: env.AWS_SECRET_ACCESS_KEY, SessionToken: env.AWS_SESSION_TOKEN };
    expect(credentialProcessResponse(env)).toEqual(response);
    const script = join(REPO_ROOT, "scripts/ci-aws-credential-process.ts");
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(response);
    for (const key of Object.keys(env)) {
      const missing: NodeJS.ProcessEnv = { ...process.env, ...env };
      delete missing[key];
      expect(() => credentialProcessResponse(missing)).toThrow(key);
      const rejected = spawnSync(process.execPath, [script], { encoding: "utf8", env: missing });
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(key);
      for (const secret of Object.values(env)) expect(rejected.stderr).not.toContain(secret);
    }
  });

  test("live families have every supported platform, opt-ins and strictness, without no-LLM", () => {
    const actual: string[] = [];
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!jobName.startsWith("live_")) continue;
      for (const step of job.steps) {
        expect(step.run ?? "").not.toMatch(/--(?:no-llm|unit|integration|e2e|isolated-e2e|bedrock-parallel|kiro-parallel|ide-parallel|require-coverage)\b/);
        expect(step.run ?? "").not.toContain("mapfile");
        expect(step.run ?? "").not.toContain(`\${ARGS`);
      }
      for (const row of rows(job)) {
        const family = FAMILIES[row.family];
        expect(family, row.family).toBeDefined();
        actual.push(`${row.family}:${row.platform}`);
        const run = job.steps.find((step) => step.run?.includes(`ci-live-filter.ts ${row.family} `));
        expect(run, `${jobName}/${row.family} command`).toBeDefined();
        expect({ ...job.env, ...run!.env }).toMatchObject(family.env);
        const command = run!.run!.replaceAll(`\${{ matrix.platform }}`, row.platform).trim();
        expect(command).toBe(`bun scripts/ci-live-filter.ts ${row.family} --platform ${row.platform} --run -- --debug -P 4`);
        expect(job["runs-on"].includes("self-hosted")).toBe(family.hosting === "self-hosted");
      }
    }
    const expected = Object.entries(FAMILIES).flatMap(([family, spec]) => spec.platforms.map((platform) => `${family}:${platform}`));
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("Kiro CLI uses hosted API-key authentication while only IDE remains self-hosted", () => {
    const job = workflow.jobs.live_kiro_api;
    expect(workflow.jobs.live_kiro_linux).toBeUndefined();
    expect(job.environment).toBe("nightly-live");
    expect(job.if).toBe("vars.AIDLC_NIGHTLY_KIRO_API == '1'");
    for (const step of job.steps.filter((step) => step.name === "Require Kiro API authentication" || step.name?.startsWith("Run kiro-"))) {
      expect(step.env?.KIRO_API_KEY).toBe(`\${{ secrets.KIRO_API_KEY }}`);
    }
    expect(workflow.on.workflow_call.secrets.KIRO_API_KEY.required).toBe(false);
    expect(job.permissions?.["id-token"]).not.toBe("write");
    expect(job.steps.some((step) => step.uses?.startsWith("aws-actions/"))).toBe(false);
    const preflight = job.steps.find((step) => step.name === "Require Kiro API authentication")!;
    expect(preflight.run).toContain('test -n "$KIRO_API_KEY"');
    expect(preflight.run).toContain("kiro-cli whoami");
    expect(workflow.jobs.live_kiro_windows.strategy?.matrix.family).toEqual(["kiro-ide"]);
  });

  test("third-party API secrets are restricted to authenticated preflights and test execution", () => {
    const exposed: string[] = [];
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const value of Object.values(job.env ?? {})) expect(value, `${name} job env`).not.toContain("secrets.");
      for (const step of job.steps) {
        const referenced = /\b(?:KIRO_API_KEY|CURSOR_API_KEY)\b/.test(JSON.stringify(step));
        if (referenced) {
          expect(step.name, `${name} secret-bearing step`).toMatch(/^(?:Require |Run )/);
          exposed.push(`${name}/${step.name}`);
        }
        if (/install/i.test(step.name ?? "") || /\b(?:bun|npm) install\b|\bcurl\b|\birm\b/.test(step.run ?? "")) {
          expect(step.env?.KIRO_API_KEY).toBeUndefined();
          expect(step.env?.CURSOR_API_KEY).toBeUndefined();
          expect(JSON.stringify(step.env ?? {})).not.toMatch(/secrets\.(?:KIRO_API_KEY|CURSOR_API_KEY)/);
        }
      }
    }
    expect(exposed.sort()).toEqual([
      "live_hosted/Require multi-provider Cursor credentials and executable",
      "live_hosted/Run multi-provider",
      "live_kiro_api/Require Kiro API authentication",
      "live_kiro_api/Run kiro-acp",
      "live_kiro_api/Run kiro-tui",
      "live_cursor/Require Cursor credentials and executable",
      "live_cursor/Run cursor",
    ].sort());
    const preflight = workflow.jobs.live_hosted.steps.find((step) => step.name === "Require multi-provider Cursor credentials and executable")!;
    expect(preflight.if).toBe("matrix.family == 'multi-provider' && vars.AIDLC_NIGHTLY_CURSOR == '1'");
    expect(preflight.env?.CURSOR_API_KEY).toBe(`\${{ secrets.CURSOR_API_KEY }}`);
    const run = workflow.jobs.live_hosted.steps.find((step) => step.name === "Run multi-provider")!;
    expect(run.env?.CURSOR_API_KEY).toBe(`\${{ vars.AIDLC_NIGHTLY_CURSOR == '1' && secrets.CURSOR_API_KEY || '' }}`);
    for (const step of workflow.jobs.live_cursor.steps.filter((step) => step.name?.startsWith("Require ") || step.name === "Run cursor")) {
      expect(step.env?.CURSOR_API_KEY).toBe(`\${{ secrets.CURSOR_API_KEY }}`);
    }
  });

  test("self-hosted Windows inventories its desktop and uses Windows PowerShell 5.1 for every command", () => {
    const job = workflow.jobs.live_kiro_windows;
    expect(job.steps[0]).toMatchObject({ name: "Inventory self-hosted Windows host", shell: "powershell" });
    expect(job.steps[0].run).toContain("(Get-Process -Id $PID).SessionId");
    expect(job.steps[0].run).toContain("if ($sessionId -eq 0) { throw");
    expect(job.steps[0].run).toContain("[int]$Matches.id -eq $sessionId");
    for (const step of job.steps) {
      if (!step.run) continue;
      expect(step.shell ?? job.defaults?.run?.shell).toBe("powershell");
    }
  });

  test("every source-executing job depends on main-source authorization", () => {
    const plan = workflow.jobs.plan;
    const authorization = plan.steps.find((step) => step.name === "Resolve immutable source")!;
    expect(plan.steps[0].with?.["fetch-depth"]).toBe(0);
    expect(authorization.run).toContain("git fetch --no-tags origin main");
    expect(authorization.run).toContain('git merge-base --is-ancestor "$sha" origin/main');
    expect(plan.steps.indexOf(authorization)).toBeLessThan(plan.steps.findIndex((step) => step.run?.includes("bun install")));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "plan") continue;
      expect(Array.isArray(job.needs) ? job.needs : [job.needs], name).toContain("plan");
    }
    expect(workflow.jobs.native_reconcile.if).toContain("needs.plan.result == 'success'");
    for (const step of workflow.jobs.result.steps) {
      if (step.with?.ref || step.uses?.startsWith("oven-sh/setup-bun@") || step.run?.includes("git rev-parse") || step.run?.includes("bun scripts/")) {
        expect(step.if).toBe(`\${{ needs.plan.result == 'success' }}`);
      }
    }
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
          if (spec.resources === "kiro") {
            expect(args[args.indexOf("--kiro-parallel") + 1]).toBe("2");
            expect(args[args.indexOf("--ide-parallel") + 1]).toBe("1");
            expect(args).not.toContain("--bedrock-parallel");
          } else {
            expect(args[args.indexOf("--bedrock-parallel") + 1]).toBe("2");
            expect(args).not.toContain("--kiro-parallel");
            expect(args).not.toContain("--ide-parallel");
          }
          expect(result.status, result.stdout + result.stderr).toBe(0);
          const plan = JSON.parse(result.stdout) as { files: Array<{ file: string }> };
          expect(plan.files.map(({ file }) => file).sort()).toEqual(selected.filter((file) => file.startsWith("tests/e2e/")));
        } else {
          for (const flag of ["--isolated-e2e", "--bedrock-parallel", "--kiro-parallel", "--ide-parallel"]) {
            expect(args).not.toContain(flag);
          }
          expect(result.status).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("isolated e2e options require --e2e --isolated-e2e (or --e2e-plan)");
        }
      }, 30_000);
    }
  }

  test("native obligations include macOS and the fail-closed result depends on every job", () => {
    expect(workflow.jobs.native_terminal.strategy?.matrix.include).toContainEqual({ job: "darwin-bun", runner: "macos-15", backend: "bun" });
    expect(workflow.jobs.result.if).toBe(`\${{ always() }}`);
    expect([...(workflow.jobs.result.needs as string[])].sort()).toEqual(Object.keys(workflow.jobs).filter((name) => name !== "result").sort());
    expect(Object.keys(workflow.jobs).filter((name) => name !== "result").sort()).toEqual([...FULL_SUITE_JOBS].sort());
    for (const job of Object.values(workflow.jobs)) {
      for (const ref of [job.uses, ...job.steps.map((step) => step.uses)].filter((ref): ref is string => !!ref)) {
        expect(ref.startsWith("./") || /^[^@\s]+@[a-f0-9]{40}$/.test(ref), ref).toBe(true);
      }
    }
  });

  test("discovery forms a disjoint partition with exact runner-alias filters", () => {
    const partition = classifyLiveFiles(REPO_ROOT);
    const discovered = [...discoverLiveFiles(REPO_ROOT).keys()].sort();
    const flattened = [...partition.values()].flat();
    expect(flattened.sort()).toEqual(discovered);
    expect(new Set(flattened).size).toBe(flattened.length);
    for (const { file } of discoverClaudeRequiredTests()) expect(flattened).toContain(file);
    expect(partition.get("multi-provider")).toContain("tests/integration/t300-plugin-kit.test.ts");
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

  test("new provider files and plugin dispatchers are classified without filename lists", () => {
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
      put("tests/harness/plugin-kit.ts", readFileSync(join(REPO_ROOT, "tests/harness/plugin-kit.ts"), "utf8"));
      put("plugins/new/tests/plugin.test.ts", 'invokeHarness(project, harness, "status");');
      const partition = classifyLiveFiles(root);
      expect(partition.get("kiro-tui")).toEqual(["tests/e2e/t-new.test.ts"]);
      expect(partition.get("codex")).toEqual(["tests/integration/t-new.test.ts"]);
      expect(partition.get("multi-provider")).toEqual(["plugins/new/tests/plugin.test.ts"]);
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
    const emitted = spawnSync(process.execPath, [script, "multi-provider", "--platform", "linux", "--args"], { encoding: "utf8" });
    expect(emitted.status, emitted.stderr).toBe(0);
    expect(emitted.stdout.trim().split("\n")).toEqual(liveRunnerArgs("multi-provider", "linux"));
    for (const args of [["missing"], ["claude-tui", "--platform", "other"], ["copilot", "--run", "--", "--e2e-plan"], ["codex", "--args", "--run"]]) {
      expect(spawnSync(process.execPath, [script, ...args]).status).toBe(2);
    }
  });

  test("passed requires successful non-excluded legs and complete additionally requires no exclusions", () => {
    expect(fullSuiteResult(allSuccess(), identity)).toMatchObject({ passed: true, complete: true, excluded: [] });
    for (const status of ["failure", "cancelled", "skipped"] as const) {
      expect(fullSuiteResult({ ...allSuccess(), live_hosted: { result: status } }, identity))
        .toMatchObject({ passed: false, complete: false });
    }
    const missing = allSuccess();
    delete missing.native_reconcile;
    expect(fullSuiteResult(missing, identity)).toMatchObject({ passed: false, complete: false, legs: { native_reconcile: "missing" } });
    expect(fullSuiteResult(allSuccess(), { ...identity, sha: "main" })).toMatchObject({ passed: false, complete: false });
  });

  for (const [job, variable] of [["live_cursor", "cursor"], ["live_kiro_api", "kiroApi"], ["live_kiro_windows", "kiro"]] as const) {
    test(`${job} is non-blocking only when explicitly disabled and skipped`, () => {
      const needs: SuiteNeeds = { ...allSuccess(), [job]: { result: "skipped" } };
      expect(fullSuiteResult(needs, identity)).toMatchObject({ passed: true, complete: false, excluded: [job] });
      expect(fullSuiteResult(needs, identity, { [variable]: "1" })).toMatchObject({ passed: false, complete: false, excluded: [] });
      for (const result of ["failure", "cancelled"] as const) {
        needs[job] = { result };
        expect(fullSuiteResult(needs, identity)).toMatchObject({ passed: false, complete: false, excluded: [] });
      }
      delete needs[job];
      expect(fullSuiteResult(needs, identity)).toMatchObject({ passed: false, complete: false, excluded: [] });
    });
  }

  test("result CLI warns about disabled families without failing the publication gate", () => {
    const root = mkdtempSync(join(tmpdir(), "full-suite-result-"));
    try {
      const needs: SuiteNeeds = {
        ...allSuccess(), live_cursor: { result: "skipped" }, live_kiro_api: { result: "skipped" }, live_kiro_windows: { result: "skipped" },
      };
      const env = {
        ...process.env, FULL_SUITE_NEEDS: JSON.stringify(needs), FULL_SUITE_SHA: identity.sha,
        AIDLC_NIGHTLY_CURSOR: "0", AIDLC_NIGHTLY_KIRO_API: "0", AIDLC_NIGHTLY_KIRO_RUNNERS: "0",
      };
      const output = join(root, "result.json");
      const script = join(REPO_ROOT, "scripts/ci-full-suite-result.ts");
      const result = spawnSync(process.execPath, [script, output], { encoding: "utf8", env });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("::warning::");
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report).toMatchObject({ passed: true, complete: false });
      expect(report.excluded.sort()).toEqual(["live_cursor", "live_kiro_api", "live_kiro_windows"]);
      const enabledSkip = spawnSync(process.execPath, [script, output], { encoding: "utf8", env: { ...env, AIDLC_NIGHTLY_KIRO_API: "1" } });
      expect(enabledSkip.status).toBe(1);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ passed: false, complete: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
