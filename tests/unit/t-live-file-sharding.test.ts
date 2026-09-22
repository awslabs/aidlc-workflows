import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  classifyLiveFiles, FAMILIES, liveFilter, liveMatrix, liveRunnerArgs, liveRunnerCommand,
  PLATFORM_ONLY, selectedLiveFiles, VERIFICATION_FAMILIES, type LiveFamily, type VerificationFamily,
} from "../../scripts/ci-live-filter.ts";
import { sandboxCommand } from "../../scripts/ci-live-sandbox.ts";
import { parseRunnerArgs } from "../harness/runner-profile.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/ci-live-filter.ts");
const partition = classifyLiveFiles(ROOT);
const platforms = ["linux", "darwin", "win32"] as const;
const runners = { linux: "ubuntu-latest", darwin: "macos-15", win32: "windows-latest" } as const;

function cli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 15_000 });
}

function qualifiedName(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/");
  const name = parts.at(-1)!.slice(0, -".test.ts".length);
  return parts[0] === "plugins" ? `plugins-plugin-${parts[1]}-${name}` : `${parts[1]}-${name}`;
}

describe("bounded live file sharding", () => {
  for (const kind of ["hosted", "windows"] as const) {
    test(`${kind} assigns every eligible file exactly once per platform in nonempty shards`, () => {
      const matrix = liveMatrix(kind);
      const planned: string[] = [];
      const expected: string[] = [];
      const slices = new Set<string>();
      expect(matrix.include.length).toBeGreaterThan(0);
      for (const [family, files] of partition) {
        const spec = FAMILIES[family];
        if (spec.hosting !== "hosted" || (kind === "windows" && family === "release-contract")) continue;
        for (const platform of platforms) {
          if ((kind === "windows") !== (platform === "win32") || !(spec.platforms as readonly string[]).includes(platform)) continue;
          for (const file of files) {
            if (!PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform)) expected.push(`${platform}:${family}:${file}`);
          }
        }
      }
      for (const row of matrix.include) {
        expect(row.runner).toBe(runners[row.platform]);
        expect(row.slice).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(slices.has(`${row.platform}:${row.slice}`)).toBe(false);
        slices.add(`${row.platform}:${row.slice}`);
        const eligible = partition.get(row.family)!.filter((file) =>
          !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(row.platform));
        const [index, total] = row.shard.split("/").map(Number);
        expect(total).toBe(eligible.length);
        const selected = selectedLiveFiles(row.family, row.platform, row.shard);
        expect(selected).toEqual([eligible[index - 1]]);
        planned.push(...selected.map((file) => `${row.platform}:${row.family}:${file}`));
      }
      expect(new Set(planned).size).toBe(planned.length);
      expect(planned.sort()).toEqual(expected.sort());
      expect(liveMatrix(kind)).toEqual(matrix);
    }, 180_000);
    for (const family of VERIFICATION_FAMILIES.filter((value) => value !== "all")) {
      test(`${kind}/${family} scope preserves every full-family shard and selects no other family`, () => {
        const all = liveMatrix(kind);
        const scoped = liveMatrix(kind, family);
        expect(liveMatrix(kind, "all")).toEqual(all);
        expect(scoped.include.length).toBeGreaterThan(0);
        expect(scoped.include).toEqual(all.include.filter((row) => row.family === family));
        const planned: string[] = [];
        const expected = platforms.filter((platform) => (kind === "windows") === (platform === "win32"))
          .flatMap((platform) => selectedLiveFiles(family, platform).map((file) => `${platform}:${file}`));
        for (const row of scoped.include) {
          const [index, total] = row.shard.split("/").map(Number);
          const files = selectedLiveFiles(family, row.platform);
          expect(total).toBe(files.length);
          expect(selectedLiveFiles(family, row.platform, row.shard)).toEqual([files[index - 1]]);
          planned.push(`${row.platform}:${files[index - 1]}`);
        }
        expect(new Set(planned).size).toBe(planned.length);
        expect(planned.sort()).toEqual(expected.sort());
        const result = cli(["--matrix", kind, "--family", family]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${JSON.stringify(scoped)}\n`);
      }, 30_000);
    }
  }

  test("platform eligibility precedes shard numbering, including the separate Windows release contract", () => {
    const windowsOnly = "tests/e2e/t-tui-journey-orientation-windows.serial.test.ts";
    const windows = selectedLiveFiles("claude-tui", "win32");
    expect(windows).toContain(windowsOnly);
    for (const platform of ["linux", "darwin"] as const) {
      const files = selectedLiveFiles("claude-tui", platform);
      expect(files).not.toContain(windowsOnly);
      expect(files.length).toBeLessThan(windows.length);
      expect(() => selectedLiveFiles("claude-tui", platform, `1/${windows.length}`)).toThrow("invalid live shard");
    }
    expect(liveMatrix("windows").include.some(({ family }) => family === "release-contract")).toBe(false);
    expect(selectedLiveFiles("release-contract", "win32", "1/1")).toEqual(partition.get("release-contract")!);
  });

  test("missing shards retain every eligible file for existing callers", () => {
    for (const [family, files] of partition) {
      if (FAMILIES[family].hosting !== "hosted") continue;
      for (const platform of platforms) {
        expect(selectedLiveFiles(family, platform)).toEqual(files.filter((file) =>
          !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform)));
      }
    }
    const args = liveRunnerArgs("claude-sdk", "linux");
    expect(args).toContain("--integration");
    expect(args).toContain("--e2e");
    expect(liveRunnerCommand("claude-sdk", "linux")).toEqual([join(ROOT, "tests/run-tests.ts"), ...args]);
    expect(liveRunnerCommand("claude-sdk", "linux", ["--debug", "-P", "8"]))
      .toEqual([join(ROOT, "tests/run-tests.ts"), "--debug", "-P", "8", ...args]);
  }, 30_000);

  test("malformed, out-of-range, unsafe, and stale shard totals are rejected", () => {
    const total = selectedLiveFiles("codex", "linux").length;
    for (const shard of [
      "", "1", "1/2/3", "1.0/2", "1e0/2", "-1/2", "+1/2", "0/2", "1/0",
      `01/${total}`, `1/0${total}`, ` 1/${total}`, `1/${total} `, `1/${total}\n`,
      `${total + 1}/${total}`, `1/${total + 1}`, `${Number.MAX_SAFE_INTEGER + 1}/${total}`,
      "1/9007199254740992",
    ]) {
      expect(() => selectedLiveFiles("codex", "linux", shard), shard).toThrow("invalid live shard");
    }
  }, 30_000);

  test("unknown and excluded families, unsupported platforms, and empty selections fail", () => {
    for (const family of ["missing", "toString", "__proto__"]) {
      expect(() => selectedLiveFiles(family as LiveFamily, "linux")).toThrow("unknown family");
    }
    for (const family of Object.keys(FAMILIES) as LiveFamily[]) {
      if (FAMILIES[family].hosting === "excluded") {
        expect(() => selectedLiveFiles(family, "linux")).toThrow("excluded");
      }
    }
    expect(() => selectedLiveFiles("codex", "aix")).toThrow("does not support");
    expect(() => liveMatrix("other" as "hosted")).toThrow("unknown live matrix");
    for (const family of ["", "unknown", "release-contract", "copilot", "kiro-tui", "codex\n"]) {
      for (const kind of ["hosted", "windows"] as const) {
        expect(() => liveMatrix(kind, family as VerificationFamily)).toThrow("unknown verification family");
      }
    }
    // In-memory platform restrictions exercise the empty-plan guard without runtime fixtures.
    const files = partition.get("opencode")!;
    const prior = files.map((file) => PLATFORM_ONLY[file]);
    try {
      for (const file of files) PLATFORM_ONLY[file] = [];
      expect(() => selectedLiveFiles("opencode", "linux")).toThrow("no selected files");
      expect(() => selectedLiveFiles("opencode", "linux", "1/1")).toThrow("no selected files");
      expect(() => liveMatrix("hosted")).toThrow("no selected files");
      expect(() => liveMatrix("windows")).toThrow("no selected files");
      expect(() => liveMatrix("hosted", "opencode")).toThrow("no selected files");
      expect(() => liveMatrix("windows", "opencode")).toThrow("no selected files");
    } finally {
      files.forEach((file, index) => {
        if (prior[index] === undefined) delete PLATFORM_ONLY[file];
        else PLATFORM_ONLY[file] = prior[index];
      });
    }
  }, 30_000);

  for (const tier of ["unit", "integration", "e2e"] as const) {
    test(`${tier} shard selects only its own tier and preserves strict coverage policy`, () => {
      const family = tier === "unit" ? "release-contract" : "claude-sdk";
      const files = selectedLiveFiles(family, "linux");
      const index = files.findIndex((file) => file.startsWith(`tests/${tier}/`));
      expect(index).toBeGreaterThanOrEqual(0);
      const shard = `${index + 1}/${files.length}`;
      const args = liveRunnerArgs(family, "linux", shard);
      const parsed = parseRunnerArgs(args, {});
      expect([parsed.runSmoke, parsed.runUnit, parsed.runIntegration, parsed.runE2e])
        .toEqual([false, tier === "unit", tier === "integration", tier === "e2e"]);
      expect(parsed.requireCoverage).toBe(FAMILIES[family].requireCoverage);
      expect(parsed.isolatedE2e).toBe(tier === "e2e");
      expect(parsed.fileTimeout).toBe(2400);
      expect(parsed.runTimeout).toBe(2400);
      const bounded = parseRunnerArgs(liveRunnerCommand(family, "linux", [
        "--file-timeout", "9000", "--run-timeout", "9000",
      ], shard).slice(1), {});
      expect(bounded.fileTimeout).toBe(2400);
      expect(bounded.runTimeout).toBe(2400);
      if (tier === "e2e") {
        expect(parsed.bedrockParallel).toBe(2);
        expect(parsed.e2eFileTimeout).toBe(2400);
      } else {
        expect(args).not.toContain("--e2e-file-timeout");
        expect(args).not.toContain("--bedrock-parallel");
      }
      const filter = new RegExp(parsed.filter);
      expect([...partition.values()].flat().filter((file) => filter.test(qualifiedName(file)))).toEqual([files[index]]);
      expect(parsed.shard).toBeNull(); // The live shard is consumed before the unit runner's distinct --shard.
      if (tier === "e2e") {
        const passthrough = ["--debug", "-P", "8", "--e2e-timings", "timings with spaces/$literal;[x].txt", "--e2e-file-timeout", "9000"];
        const command = liveRunnerCommand(family, "linux", passthrough, shard);
        expect(command).toEqual([join(ROOT, "tests/run-tests.ts"), ...passthrough, ...args]);
        const forwarded = parseRunnerArgs(command.slice(1), {});
        expect(forwarded.e2eTimings).toBe(passthrough[4]);
        expect(forwarded.e2eFileTimeout).toBe(2400);
        expect(forwarded.parallel).toBe(8);
      }
    });
  }

  test("passthrough cannot change discovered tiers, coverage, filters, or shard ownership", () => {
    for (const selector of [
      "--smoke", "--unit", "--integration", "--e2e", "--ci", "--all", "--release",
      "--filter", "--filter=.*", "--shard", "--matrix-plan", "--matrix-job", "--no-llm",
    ]) {
      expect(() => liveRunnerCommand("codex", "linux", [selector], "1/5")).toThrow("cannot be overridden");
    }
  });

  test("filters escape literal metacharacters and distinguish tier, plugin, and Windows aliases", () => {
    const name = "t-a.b+[c](d){2}^$|?*";
    const files = [`tests/e2e/${name}.test.ts`, `plugins/p.l+g/tests/${name}.test.ts`];
    const filter = new RegExp(liveFilter(files));
    for (const file of files) {
      const alias = qualifiedName(file);
      expect(filter.test(alias)).toBe(true);
      expect(filter.test(`prefix-${alias}`)).toBe(false);
      expect(filter.test(`${alias}-suffix`)).toBe(false);
      expect(filter.test(alias.replace(".", "X"))).toBe(false);
    }
    expect(filter.test(`integration-${name}`)).toBe(false);
    expect(filter.test(`plugins-plugin-other-${name}`)).toBe(false);
    expect(liveFilter(files.map((file) => file.replaceAll("/", "\\")))).toBe(liveFilter(files));
    expect(new RegExp(liveFilter([])).test("")).toBe(false);
  });

  test("sandbox forwards optional shards as individual arguments with eight workers", () => {
    const total = selectedLiveFiles("codex", "linux").length;
    const shard = `1/${total}`;
    const prefix = [process.execPath, "scripts/ci-live-filter.ts", "codex", "--platform", "linux"];
    expect(sandboxCommand("codex", "linux")).toEqual([...prefix, "--run", "--", "--debug", "-P", "8"]);
    expect(sandboxCommand("codex", "linux", shard))
      .toEqual([...prefix, "--shard", shard, "--run", "--", "--debug", "-P", "8"]);
    expect(() => sandboxCommand("codex", "linux", `${shard} --unit`)).toThrow("invalid live shard");
  });

  test("CLI emits compact matrices and matching shard filters/arguments", () => {
    for (const kind of ["hosted", "windows"] as const) {
      const result = cli(["--matrix", kind]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${JSON.stringify(liveMatrix(kind))}\n`);
    }
    const files = selectedLiveFiles("claude-sdk", "linux");
    const shard = `1/${files.length}`;
    const args = ["claude-sdk", "--platform", "linux", "--shard", shard];
    const filter = cli(args);
    expect(filter.status, filter.stderr).toBe(0);
    expect(filter.stdout.trim()).toBe(liveFilter([files[0]]));
    const emitted = cli([...args, "--args"]);
    expect(emitted.status, emitted.stderr).toBe(0);
    expect(emitted.stdout.trim().split("\n")).toEqual(liveRunnerArgs("claude-sdk", "linux", shard));
    // --e2e-plan only computes the inventory; it does not run live tests or build fixtures.
    const plan = cli([...args, "--run", "--", "--debug", "-P", "8", "--e2e-plan"]);
    expect(plan.status, plan.stdout + plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout).files.map(({ file }: { file: string }) => file)).toContain(files[0]);
  }, 30_000);

  test("CLI rejects invalid shards in every mode and refuses passthrough selectors", () => {
    for (const args of [
      ["--matrix"], ["--matrix", "other"], ["--matrix", "hosted", "--args"],
      ["--matrix", "hosted", "--family"], ["--matrix", "hosted", "--family", ""],
      ["--matrix", "hosted", "--family", "unknown"], ["--matrix", "windows", "--family", "release-contract"],
      ["--matrix", "hosted", "--family", "codex", "--family", "opencode"],
      ["codex", "--family", "codex"],
      ["codex", "--shard"], ["codex", "--shard", "1/999"],
      ["codex", "--shard", "1/999", "--args"],
      ["codex", "--shard", "1/999", "--run", "--", "--e2e-plan"],
      ["codex", "--shard", "1/5", "--shard", "2/5"],
      ["codex", "--run", "--", "--unit", "--e2e-plan"],
      ["copilot"], ["missing"], ["codex", "--platform", "aix"],
    ]) {
      const result = cli(args);
      expect(result.status, `${JSON.stringify(args)}: ${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
    }
  }, 30_000);
});
