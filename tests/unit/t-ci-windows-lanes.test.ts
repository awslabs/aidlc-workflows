// covers: harness-instrument:ci-windows-lanes
//
// Pins the three advisory Windows lanes ci.yml gained after the PR 1369 review:
// the documented install.ps1 one-liner under Windows PowerShell 5.1, the hook
// contracts with Git Bash removed from PATH, and the smoke tier inside WSL 1.
// Each lane follows the cross-OS convention (merge queue and manual runs, not
// PR pushes), pins its actions by commit, uses the runner's generous timeout
// hierarchy, and stays out of the required summary job until it has a first
// green run on GitHub. The hooks filter must select only files that exist and
// must never pull in the one test that emulates Claude Code's shell with bash.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CI_PATH = join(REPO_ROOT, ".github/workflows/ci.yml");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
  "timeout-minutes"?: number;
};
type Job = {
  name?: string;
  if?: string;
  "runs-on"?: string;
  needs?: string[];
  "timeout-minutes"?: number;
  defaults?: { run?: { shell?: string } };
  steps?: Step[];
};

const text = readFileSync(CI_PATH, "utf8");
const ci = Bun.YAML.parse(text) as { jobs: Record<string, Job> };
const LANES = ["test_windows_install_ps51", "test_hooks_without_git_bash", "test_wsl_smoke"] as const;

const steps = (job: Job): Step[] => job.steps ?? [];
const step = (job: Job, name: string): Step => {
  const found = steps(job).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing step ${JSON.stringify(name)}`);
  return found;
};

/** The same OR matching as run-tests.ts matchesE2eFilter and t345's aliases:
 *  basename with extension, the legacy stem, and the tier-qualified stem. */
function aliases(file: string): string[] {
  const [tier] = file.split("/").slice(-2);
  const stem = basename(file, ".test.ts");
  return [basename(file), stem, `${tier}-${stem}`];
}

function deterministicFiles(): string[] {
  return ["smoke", "unit", "integration"].flatMap((tier) =>
    readdirSync(join(REPO_ROOT, "tests", tier))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => `tests/${tier}/${file}`));
}

describe("t-ci-windows-lanes", () => {
  test("every Windows lane follows the cross-OS gating, runner and timeout conventions", () => {
    for (const name of LANES) {
      const job = ci.jobs[name];
      expect(job, name).toBeDefined();
      expect(job.if, name).toBe("github.event_name != 'pull_request'");
      expect(job["runs-on"], name).toBe("windows-latest");
      expect(job["timeout-minutes"], name).toBe(300);
      expect(job.needs, name).toBeUndefined();
      for (const item of steps(job)) {
        // No step falls back to the runner's bash shell; the hooks lane in
        // particular must not rely on the very shell it removes.
        expect(item.shell, `${name}: ${item.name ?? item.uses ?? item.run}`).not.toBe("bash");
        if (item.uses) expect(item.uses, name).toMatch(/@[0-9a-f]{40}$/);
      }
      const checkout = steps(job)[0];
      expect(checkout.uses, name).toMatch(/^actions\/checkout@/);
      expect(checkout.with?.["persist-credentials"], name).toBe(false);
      expect(JSON.stringify(job), name).not.toContain("secrets.");
    }
    // Advisory until a first green run: the required summary does not depend on them.
    for (const name of LANES) expect(ci.jobs.test.needs).not.toContain(name);
    expect(text).toContain("They are advisory until their first green run");
  });

  test("the PowerShell 5.1 lane installs from a same-commit candidate with the documented one-liner", () => {
    const job = ci.jobs.test_windows_install_ps51;
    expect(job.defaults?.run?.shell).toBe("powershell");
    for (const item of steps(job)) expect(item.shell).toBeUndefined();
    const stage = step(job, "Stage a release candidate from this commit").run!;
    expect(stage.indexOf("bun scripts/build-binaries.ts --target bun-windows-x64"))
      .toBeLessThan(stage.indexOf("bun scripts/package-release.ts"));
    expect(stage).toContain("build/release/aidlc-release.intoto.jsonl");
    const install = step(job, "Install with the documented one-liner under Windows PowerShell 5.1");
    expect(install["timeout-minutes"]).toBe(60);
    const run = install.run!;
    expect(run).toContain("if ($PSVersionTable.PSVersion.Major -ne 5)");
    expect(run).toContain(".github/scripts/serve-release-directory.ts");
    // The README command shape, executed by a fresh powershell.exe.
    expect(run).toContain(`$oneLiner = "irm $base/latest/download/install.ps1 | iex"`);
    expect(run).toContain("Start-Process -FilePath powershell.exe");
    expect(run).toContain("'-EncodedCommand', $encoded");
    expect(run).not.toContain("pwsh");
    for (const variable of ["AIDLC_RELEASE_BASE_URL", "AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_ALLOW_ADMIN_INSTALL", "AIDLC_GH_BIN"]) {
      expect(run).toContain(`$env:${variable} = `);
    }
    expect(run).toContain("Join-Path $env:RUNNER_TEMP 'aidlc-ps51-machine'");
    expect(run).toContain("attestation verification is unavailable");
    for (const command of ["& $aidlc version", "& $aidlc config --project-dir $project --harness claude --mcp none --quiet", "& $aidlc doctor --project-dir $project --quiet"]) {
      expect(run).toContain(command);
    }
    expect(run).toContain("Stop-Process -Id $server.Id");
  });

  test("the hooks lane removes Git Bash, proves sh is gone, and selects real hook contracts through the native runner", () => {
    const job = ci.jobs.test_hooks_without_git_bash;
    expect(job.defaults?.run?.shell).toBe("powershell");
    const build = steps(job).findIndex((item) => item.run === "bun scripts/package.ts");
    const contracts = step(job, "Prove sh is unresolvable, then run hook contracts");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(steps(job).indexOf(contracts));
    expect(contracts["timeout-minutes"]).toBe(270);
    const run = contracts.run!;
    expect(run).toContain(String.raw`$_ -notmatch '\\Git\\(bin|usr\\bin|mingw64\\bin)\\?$'`);
    expect(run).toContain("if (Get-Command sh -CommandType Application -ErrorAction SilentlyContinue) { throw 'sh still resolves on PATH' }");
    expect(run).toContain("$bash.Source -match '\\\\Git\\\\'");
    expect(run).toContain("'tests/run-tests.ts'");
    expect(run).not.toContain("run-tests.sh");
    expect(run).toContain("'--file-timeout', '7200', '--run-timeout', '14400', '--filter', $env:TEST_FILTER");
    for (const tier of ["'--smoke'", "'--unit'", "'--integration'", "'--no-llm'"]) expect(run).toContain(tier);

    const filter = new RegExp(contracts.env!.TEST_FILTER);
    const files = deterministicFiles();
    const selected = files.filter((file) => aliases(file).some((alias) => filter.test(alias)));
    // Every alternative names an existing deterministic test; nothing silently drops out.
    const alternatives = contracts.env!.TEST_FILTER.slice(2, -2).split("|");
    expect(alternatives.length).toBeGreaterThanOrEqual(30);
    for (const alternative of alternatives) {
      expect(selected.map((file) => basename(file, ".test.ts")), alternative).toContain(alternative);
    }
    expect(selected).toHaveLength(alternatives.length);
    // The set spans the hook engine, every harness adapter and the guards.
    for (const required of [
      "tests/smoke/t02-hook-executability.test.ts",
      "tests/unit/t07-hook-audit-logger.test.ts",
      "tests/unit/t147-kiro-hook-adapter.test.ts",
      "tests/unit/t149-codex-hook-adapter.test.ts",
      "tests/unit/t218-kiro-ide-hook-adapter.test.ts",
      "tests/unit/t241-opencode-adapter.test.ts",
      "tests/unit/t249-copilot-adapter.test.ts",
      "tests/unit/t276-cursor-adapter.test.ts",
      "tests/integration/t121-stop-hook-enforce.test.ts",
    ]) {
      expect(selected).toContain(required);
    }
    // These spawn bash on purpose to emulate Claude Code's Bash tool; without
    // Git Bash, Windows resolves `bash` to the WSL stub. They must stay out.
    expect(selected).not.toContain("tests/unit/t-claude-hook-project-root.test.ts");
    expect(selected).not.toContain("tests/unit/t265-plan-approval-guard.test.ts");
    expect(text).toContain("Claude Code's Bash tool: t-claude-hook-project-root, and t265's");
  });

  test("the WSL lane pins setup-wsl to a commit, uses WSL 1, and runs smoke, hook units and a compiled binary inside the distro", () => {
    const job = ci.jobs.test_wsl_smoke;
    const wsl = steps(job).find((item) => item.uses?.startsWith("Vampire/setup-wsl@"))!;
    expect(wsl.uses).toBe("Vampire/setup-wsl@d1da7f2c0322a5ee4f24975344f67fc0f5baf364");
    expect(text).toContain("Vampire/setup-wsl@d1da7f2c0322a5ee4f24975344f67fc0f5baf364 # v7.0.0");
    expect(wsl.with).toMatchObject({ distribution: "Ubuntu-24.04", "wsl-version": 1 });
    expect(String(wsl.with?.["additional-packages"]).split(" ").sort()).toEqual(["ca-certificates", "curl", "git", "unzip"]);
    const bun = step(job, "Install the pinned Bun inside WSL");
    expect(bun.shell).toBe("wsl-bash {0}");
    expect(bun.run).toContain('curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"');
    expect(bun.run).toContain('test "$("$HOME/.bun/bin/bun" --version)" = 1.4.2');
    const smoke = step(job, "Run the smoke tier, hook units and a compiled binary inside WSL");
    expect(smoke.shell).toBe("wsl-bash {0}");
    expect(smoke["timeout-minutes"]).toBe(270);
    const run = smoke.run!;
    // No Windows environment reaches wsl-bash; everything derives from $PWD.
    expect(run).not.toContain("${{");
    expect(run).not.toContain("GITHUB_");
    expect(run).toContain('git clone --quiet "$workspace" "$HOME/aidlc"');
    expect(run).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(run).toContain("bun scripts/package.ts");
    // Only t05 is excluded: it starts the TUI preflight, whose Linux supervisor
    // needs memfd_create/pidfd that WSL 1's kernel emulation lacks.
    expect(run).toContain("bun tests/run-tests.ts --debug -P 4 --smoke --no-llm --file-timeout 7200 --run-timeout 14400 --filter '^(?!(smoke-)?t05-run-tests-parallel)'");
    const smokeFilter = /--smoke [^\n]*--filter '([^']+)'/.exec(run)![1];
    const smokeFiles = readdirSync(join(REPO_ROOT, "tests/smoke")).filter((file) => file.endsWith(".test.ts"));
    const excluded = smokeFiles.filter((file) => !aliases(`tests/smoke/${file}`).some((alias) => new RegExp(smokeFilter).test(alias)));
    expect(excluded).toEqual(["t05-run-tests-parallel.test.ts"]);
    expect(run).toContain("--unit --no-llm --file-timeout 7200 --run-timeout 14400 --filter '^(t07-hook-audit-logger|t228-hook-run-exports)$'");
    expect(run).toContain("bun scripts/build-binaries.ts --target bun-linux-x64");
    expect(run).toContain("build/binaries/linux-x64/aidlc version");
    expect(run).toContain("build/binaries/linux-x64/aidlc doctor --project-dir");
    expect(run.trimEnd().endsWith('exit "$result"')).toBe(true);
    // Evidence is sanitized by the Windows side before upload.
    expect(step(job, "Sanitize WSL evidence")).toMatchObject({ shell: "powershell", run: "bun scripts/ci-sanitize-logs.ts tmp/ci-wsl" });
    expect(step(job, "Preserve WSL evidence").with).toMatchObject({ name: "ci-wsl-Windows", path: "tmp/ci-wsl/" });
  });
});
