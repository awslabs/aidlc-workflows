import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyLiveFiles, discoverLiveFiles, FAMILIES, liveFilter, liveRunnerArgs, liveRunnerCommand, liveRunnerEnvironment, PLATFORM_ONLY, type LiveFamily } from "../../scripts/ci-live-filter.ts";
import { FULL_SUITE_JOBS, fullSuiteResult, type SuiteNeeds } from "../../scripts/ci-full-suite-result.ts";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";
import { brokerChildEnvironment } from "../../scripts/ci-start-credential-broker.ts";
import { sandboxEnvironment } from "../../scripts/ci-live-sandbox.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { setupCodexProject } from "../harness/exec-drive.ts";
import { parse } from "smol-toml";

interface Step {
  name?: string;
  id?: string;
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
const excludedFamilies = Object.entries(FAMILIES).filter(([, family]) => family.hosting === "excluded")
  .map(([name]) => name).sort();

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

  test("dependency preparation and OIDC-bearing jobs require explicit nightly live opt-in", () => {
    const jobs = Object.entries(workflow.jobs);
    const oidcJobs = jobs.filter(([, job]) => job.permissions?.["id-token"] === "write").map(([name]) => name).sort();
    expect(oidcJobs).toEqual(["live_hosted", "live_windows"]);
    const gatedJobs = jobs.filter(([, job]) => job.if === "vars.AIDLC_NIGHTLY_LIVE == '1'").map(([name]) => name).sort();
    expect(gatedJobs).toEqual(["live_hosted", "live_prepare", "live_windows"]);
    expect(workflow.jobs.live_prepare.permissions).toEqual({ contents: "read" });
    for (const name of oidcJobs) {
      const job = workflow.jobs[name];
      expect(job.needs).toContain("live_prepare");
      const download = job.steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
      const prepare = job.steps.findIndex((step) => step.name === "Prepare separate-user live runtime");
      expect(download).toBeGreaterThanOrEqual(0);
      expect(download).toBeLessThan(prepare);
      for (const step of job.steps) {
        expect(step.run ?? "").not.toMatch(/\b(bun|npm|npx|pnpm|yarn|pip|pip3|cargo)\s+(install|i|ci|add)\b/);
        expect(step.run ?? "").not.toContain("scripts/package.ts");
      }
    }
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
      const assume = job.steps.find((step) => step.name === "Assume nightly Bedrock role")!;
      expect(assume.with).toMatchObject({ "output-credentials": true, "output-env-credentials": false });
      const startup = job.steps.find((step) => step.name === "Start credential-isolated Bedrock broker")!;
      expect(startup.run).toContain("ci-start-credential-broker.ts");
      expect(startup.env?.BROKER_ACCESS_KEY_ID).toBe(`\${{ steps.aws.outputs.aws-access-key-id }}`);
      expect(job.steps.find((step) => step.name === "Assert live runner has no AWS credentials")).toBeDefined();
    }
    for (const [name, live] of Object.entries(workflow.jobs)) {
      if (!name.startsWith("live_")) continue;
      for (const step of live.steps) {
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
    expect(job.steps.find((step) => step.name === "Prove POSIX isolation")?.run).toBe("bash .github/scripts/prepare-live-runtime.sh prove");
    expect(job.steps.find((step) => step.name === "Prove Windows isolation")?.run).toBe(".github/scripts/prepare-live-runtime.ps1 -Mode prove");
    expect(job.steps.find((step) => step.name === "Exercise POSIX isolated smoke command")?.run).toContain("prepare-live-runtime.sh smoke");
    expect(job.steps.find((step) => step.name === "Exercise Windows isolated smoke command")?.run).toContain("prepare-live-runtime.ps1 -Mode smoke");
    expect(JSON.stringify(job)).not.toContain("secrets.");
  });

  test("all tests/logs uploads require successful sanitization even after test failure", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const [index, step] of job.steps.entries()) {
        if (!step.uses?.startsWith("actions/upload-artifact@") || step.with?.path !== "tests/logs/") continue;
        const sanitize = job.steps[index - 1];
        expect(sanitize).toMatchObject({ id: "sanitize", if: `\${{ always() }}`, run: "bun scripts/ci-sanitize-logs.ts tests/logs" });
        expect(step.if).toBe(`\${{ always() && steps.sanitize.outcome == 'success' }}`);
      }
    }
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
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(job["runs-on"]).not.toContain("self-hosted");
      if (!jobName.startsWith("live_") && jobName !== "release_contract_windows") continue;
      for (const step of job.steps) {
        expect(step.run ?? "").not.toMatch(/--(?:no-llm|unit|integration|e2e|isolated-e2e|bedrock-parallel|kiro-parallel|ide-parallel|require-coverage)\b/);
        expect(step.run ?? "").not.toContain("mapfile");
        expect(step.run ?? "").not.toContain(`\${ARGS`);
      }
      for (const row of rows(job)) {
        const family = FAMILIES[row.family];
        expect(family, row.family).toBeDefined();
        actual.push(`${row.family}:${row.platform}`);
        const run = job.steps.find((step) => step.name === `Run ${row.family}`);
        expect(run, `${jobName}/${row.family} command`).toBeDefined();
        expect({ ...job.env, ...run!.env }).toMatchObject(family.env);
        const command = run!.run!.replaceAll(`\${{ matrix.platform }}`, row.platform).trim();
        if (jobName === "live_hosted") {
          expect(command).toContain("sudo -u aidlc-live -H env -i");
          expect(command).toContain('cd "$AIDLC_LIVE_ROOT" && exec "$@"');
          expect(command).toContain(`ci-live-sandbox.ts" ${row.family} ${row.platform}`);
          const proof = job.steps.findIndex((step) => step.name === "Prove isolation");
          expect(proof).toBeGreaterThanOrEqual(0);
          expect(proof).toBeLessThan(job.steps.indexOf(run!));
        } else if (jobName === "live_windows") {
          expect(command).toBe(`.github/scripts/prepare-live-runtime.ps1 -Mode run -Family ${row.family}`);
          const proof = job.steps.findIndex((step) => step.name === "Prove isolation");
          expect(proof).toBeGreaterThanOrEqual(0);
          expect(proof).toBeLessThan(job.steps.indexOf(run!));
        } else {
          expect(job.if).toBeUndefined();
          expect(command).toBe(`bun scripts/ci-live-filter.ts ${row.family} --platform ${row.platform} --run -- --debug -P 4`);
        }
      }
    }
    const expected = Object.entries(FAMILIES).flatMap(([family, spec]) => spec.platforms.map((platform) => `${family}:${platform}`));
    expect(actual.sort()).toEqual(expected.sort());
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
      expect(env.TMPDIR).toBe("/home/aidlc-live/tmp");
      expect(env.BUN_INSTALL).toBe("/home/aidlc-live/.bun");
      expect(env.XDG_CACHE_HOME).toBe("/home/aidlc-live/.cache");
      expect(Object.keys(env).filter((key) => /^(ACTIONS_|AWS_|GITHUB_TOKEN|GH_TOKEN)/.test(key))).toEqual([]);
      expect(env).toMatchObject(FAMILIES[family].env);
    }
  });

  test("Kiro and Cursor are excluded without exposing vendor API keys", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(name).not.toContain("kiro");
      const matrix = job.strategy?.matrix;
      for (const family of [...(matrix?.family ?? []), ...(matrix?.include ?? []).map((row) => row.family ?? "")]) {
        expect(family).not.toContain("kiro");
      }
    }
    expect(workflow.jobs.live_cursor).toBeUndefined();
    expect(workflow.on.workflow_call.secrets.KIRO_API_KEY).toBeUndefined();
    expect(workflow.on.workflow_call.secrets.CURSOR_API_KEY).toBeUndefined();
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
      for (const step of job.steps) {
        expect(step.env?.KIRO_API_KEY).toBeUndefined();
        expect(step.env?.CURSOR_API_KEY).toBeUndefined();
        expect(JSON.stringify(step)).not.toMatch(/secrets\.(?:KIRO_API_KEY|CURSOR_API_KEY)/);
      }
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
          expect(args[args.indexOf("--bedrock-parallel") + 1]).toBe("2");
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

  test("disabled live lanes must be skipped and are not tested coverage", () => {
    const needs = { ...allSuccess(), live_prepare: { result: "skipped" as const }, live_hosted: { result: "skipped" as const }, live_windows: { result: "skipped" as const } };
    for (const live of [undefined, "", "0"]) {
      expect(fullSuiteResult(needs, identity, { live })).toMatchObject({
        passed: true, complete: false, disabledLegs: ["live_prepare", "live_hosted", "live_windows"], excluded: excludedFamilies,
      });
    }
    for (const job of ["live_prepare", "live_hosted", "live_windows"]) {
      for (const status of ["success", "failure", "cancelled"] as const) {
        expect(fullSuiteResult({ ...needs, [job]: { result: status } }, identity, {})).toMatchObject({ passed: false, complete: false });
      }
      const missing: SuiteNeeds = { ...needs };
      delete missing[job];
      expect(fullSuiteResult(missing, identity, {})).toMatchObject({ passed: false, complete: false });
    }
  });

  test("enabled live lanes and every other declared job must succeed", () => {
    expect(fullSuiteResult(allSuccess(), identity, { live: "1" })).toMatchObject({
      passed: true, complete: false, disabledLegs: [], excluded: excludedFamilies,
    });
    for (const job of ["live_prepare", "live_hosted", "live_windows", "release_contract_windows"]) {
      for (const status of ["failure", "cancelled", "skipped"] as const) {
        expect(fullSuiteResult({ ...allSuccess(), [job]: { result: status } }, identity, { live: "1" }))
          .toMatchObject({ passed: false, complete: false });
      }
      const missing = allSuccess();
      delete missing[job];
      expect(fullSuiteResult(missing, identity, { live: "1" })).toMatchObject({ passed: false, complete: false, legs: { [job]: "missing" } });
    }
    expect(fullSuiteResult(allSuccess(), { ...identity, sha: "main" }, { live: "1" })).toMatchObject({ passed: false, complete: false });
  });

  test("result CLI warns about disabled lanes and excluded families but rejects missing jobs and configuration errors", () => {
    const root = mkdtempSync(join(tmpdir(), "full-suite-result-"));
    try {
      const needs: SuiteNeeds = { ...allSuccess(), live_prepare: { result: "skipped" }, live_hosted: { result: "skipped" }, live_windows: { result: "skipped" } };
      const env = {
        ...process.env, AIDLC_NIGHTLY_LIVE: "", FULL_SUITE_NEEDS: JSON.stringify(needs), FULL_SUITE_SHA: identity.sha,
      };
      const output = join(root, "result.json");
      const script = join(REPO_ROOT, "scripts/ci-full-suite-result.ts");
      const result = spawnSync(process.execPath, [script, output], { encoding: "utf8", env });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("::warning::Full suite ran with the live lanes disabled (AIDLC_NIGHTLY_LIVE unset): live_prepare, live_hosted, live_windows");
      expect(result.stderr).toContain(`::warning::Full suite excluded families: ${excludedFamilies.join(", ")}`);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report).toMatchObject({ passed: true, complete: false, disabledLegs: ["live_prepare", "live_hosted", "live_windows"], excluded: excludedFamilies });
      const unexpectedRun = spawnSync(process.execPath, [script, output], { encoding: "utf8", env: { ...env, FULL_SUITE_NEEDS: JSON.stringify(allSuccess()) } });
      expect(unexpectedRun.status).toBe(1);
      expect(unexpectedRun.stderr).toContain("::error::Live-lane configuration error: AIDLC_NIGHTLY_LIVE is not '1' but these jobs ran: live_prepare=success, live_hosted=success, live_windows=success");
      delete needs.native_reconcile;
      const missing = spawnSync(process.execPath, [script, output], { encoding: "utf8", env: { ...env, FULL_SUITE_NEEDS: JSON.stringify(needs) } });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("native_reconcile=missing");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ passed: false, complete: false, excluded: excludedFamilies });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
