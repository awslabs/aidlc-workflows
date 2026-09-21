import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyLiveFiles, discoverLiveFiles, FAMILIES, liveFilter, PLATFORM_ONLY, type LiveFamily } from "../../scripts/ci-live-filter.ts";
import { FULL_SUITE_JOBS, fullSuiteResult, type SuiteNeeds } from "../../scripts/ci-full-suite-result.ts";
import { discoverClaudeRequiredTests } from "../harness/claude-gate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

interface Step {
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
  strategy?: { matrix: { include?: Array<Record<string, string>>; family?: LiveFamily[] } };
  steps: Step[];
}
const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/full-suite.yml"), "utf8")) as {
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
  if (matrix?.include) return matrix.include.map((row) => ({ family: row.family as LiveFamily, platform: platformOf(row.runner) }));
  return (matrix?.family ?? []).map((family) => ({ family, platform: platformOf(job["runs-on"]) }));
}

function allSuccess(): SuiteNeeds {
  return Object.fromEntries(FULL_SUITE_JOBS.map((job) => [job, { result: "success" as const }]));
}
const identity = { sha: "a".repeat(40), runId: "123", runAttempt: "2" };

describe("t345 complete nightly coverage", () => {
  test("live families have every supported platform, opt-ins and strictness, without no-LLM", () => {
    const actual: string[] = [];
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!jobName.startsWith("live_")) continue;
      for (const step of job.steps) expect(step.run ?? "").not.toContain("--no-llm");
      for (const row of rows(job)) {
        const family = FAMILIES[row.family];
        expect(family, row.family).toBeDefined();
        actual.push(`${row.family}:${row.platform}`);
        const run = job.steps.find((step) => step.run?.includes(`ci-live-filter.ts ${row.family} `));
        expect(run, `${jobName}/${row.family} command`).toBeDefined();
        expect({ ...job.env, ...run!.env }).toMatchObject(family.env);
        expect(run!.run!.includes("--require-coverage")).toBe(family.requireCoverage);
        expect(run!.run).toContain("--platform ");
        expect(run!.run).toContain("--filter \"$FILTER\"");
        expect(job["runs-on"].includes("self-hosted")).toBe(family.hosting === "self-hosted");
      }
    }
    const expected = Object.entries(FAMILIES).flatMap(([family, spec]) => spec.platforms.map((platform) => `${family}:${platform}`));
    expect(actual.sort()).toEqual(expected.sort());
  });

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
    for (const args of [["missing"], ["claude-tui", "--platform", "other"]]) {
      expect(spawnSync(process.execPath, [script, ...args]).status).toBe(2);
    }
  });

  test("complete means all declared legs succeeded for an immutable SHA", () => {
    expect(fullSuiteResult(allSuccess(), identity)).toMatchObject({ complete: true, excluded: [] });
    for (const status of ["failure", "cancelled", "skipped"] as const) {
      expect(fullSuiteResult({ ...allSuccess(), live_hosted: { result: status } }, identity).complete).toBe(false);
    }
    const missing = allSuccess();
    delete missing.native_reconcile;
    expect(fullSuiteResult(missing, identity)).toMatchObject({ complete: false, legs: { native_reconcile: "missing" } });
    expect(fullSuiteResult(allSuccess(), { ...identity, sha: "main" }).complete).toBe(false);
  });

  test("disabled repository-variable legs are excluded but never complete", () => {
    const needs: SuiteNeeds = { ...allSuccess(), live_cursor: { result: "skipped" } };
    expect(fullSuiteResult(needs, identity)).toMatchObject({ complete: false, excluded: ["live_cursor"] });
    expect(fullSuiteResult(needs, identity, { cursor: "1" })).toMatchObject({ complete: false, excluded: [] });
    needs.live_kiro_linux = { result: "skipped" };
    needs.live_kiro_windows = { result: "skipped" };
    expect(fullSuiteResult(needs, identity).excluded.sort()).toEqual(["live_cursor", "live_kiro_linux", "live_kiro_windows"]);
  });
});
