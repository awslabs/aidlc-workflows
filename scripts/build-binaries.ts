#!/usr/bin/env bun
// scripts/build-binaries.ts - release artifact builder for the single AIDLC CLI.
//
// This stays separate from scripts/package.ts. package.ts is the deterministic
// source projection and drift guard for dist/<harness>/; this script is the
// release-oriented executable build that compiles the generated Claude
// dispatcher and then smoke-gates each artifact. The binary entry is
// dist/claude/.claude/tools/aidlc.ts on purpose: release artifacts must embed
// the shipped copy, not core/. Run `bun scripts/package.ts --check` first; this
// script enforces that guard before compiling.
//
// Never enable Bun bytecode. BYTECODE-1: Bun can exit 0, emit an artifact, and still
// produce a binary that crashes before the dispatcher runs on this codebase.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../dist/claude/.claude/tools/aidlc-version.ts";

type TargetConfig = {
  name: string;
  bunTarget: string | null;
  artifact: string;
  fileNeedle?: string;
};

type CommandResult = {
  command: string[];
  cwd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type GateResult = {
  name: string;
  ok: boolean;
  kind: "command" | "inspection";
  command?: string[];
  cwd?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  expected?: string | number;
  actual?: string | number;
  detail?: string;
};

type TargetResult = {
  name: string;
  bunTarget: string | null;
  artifact: string;
  requestedArtifact: string;
  artifactNote?: string;
  seconds: number;
  bytes: number;
  build: CommandResult;
  gates: GateResult[];
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENTRY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "build", "binaries");
const MIN_CROSS_BYTES = 10 * 1024 * 1024;
const DEV_SPAWN_MARKER = "/* dev-mode bun spawn */";

function repoResolve(value: string): string {
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

// Test-only seams. AIDLC_BUILD_ENTRY lets the unit test compile a fake
// dispatcher to prove the smoke gate can fail. AIDLC_BUILD_OUT_DIR keeps that
// failure proof out of the real release staging directory.
const ENTRY = repoResolve(process.env.AIDLC_BUILD_ENTRY ?? DEFAULT_ENTRY);
const OUT_DIR = repoResolve(process.env.AIDLC_BUILD_OUT_DIR ?? DEFAULT_OUT_DIR);

function targetConfigs(outDir: string): TargetConfig[] {
  return [
    { name: "native", bunTarget: null, artifact: join(outDir, "aidlc-native") },
    { name: "darwin-x64", bunTarget: "bun-darwin-x64", artifact: join(outDir, "aidlc-darwin-x64"), fileNeedle: "Mach-O" },
    { name: "darwin-arm64", bunTarget: "bun-darwin-arm64", artifact: join(outDir, "aidlc-darwin-arm64"), fileNeedle: "Mach-O" },
    { name: "linux-x64", bunTarget: "bun-linux-x64", artifact: join(outDir, "aidlc-linux-x64"), fileNeedle: "ELF" },
    { name: "linux-arm64", bunTarget: "bun-linux-arm64", artifact: join(outDir, "aidlc-linux-arm64"), fileNeedle: "ELF" },
    { name: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", artifact: join(outDir, "aidlc-linux-x64-musl"), fileNeedle: "ELF" },
    { name: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", artifact: join(outDir, "aidlc-linux-arm64-musl"), fileNeedle: "ELF" },
    { name: "linux-x64-baseline", bunTarget: "bun-linux-x64-baseline", artifact: join(outDir, "aidlc-linux-x64-baseline"), fileNeedle: "ELF" },
    { name: "windows-x64", bunTarget: "bun-windows-x64", artifact: join(outDir, "aidlc-windows-x64"), fileNeedle: "PE32+" },
  ];
}

function usage(): string {
  return [
    "Usage: bun scripts/build-binaries.ts [--all-targets | --target <bun-target>]",
    "",
    "Default builds the native artifact only.",
    "--all-targets builds native plus the release cross-target matrix.",
    "--target builds exactly one target, for example bun-linux-x64 or native.",
  ].join("\n");
}

function failUsage(message: string): never {
  console.error(`${message}\n\n${usage()}`);
  process.exit(2);
}

function selectedTargets(argv: string[]): TargetConfig[] {
  let allTargets = false;
  let singleTarget: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--all-targets") {
      allTargets = true;
      continue;
    }
    if (arg === "--target") {
      const value = argv[++i];
      if (!value) failUsage("--target requires a bun target value");
      singleTarget = value;
      continue;
    }
    failUsage(`unknown argument: ${arg}`);
  }
  if (allTargets && singleTarget) failUsage("use either --all-targets or --target, not both");

  const targets = targetConfigs(OUT_DIR);
  if (!allTargets && !singleTarget) return [targets[0]];
  if (allTargets) return targets;

  const found = targets.find((target) => target.name === singleTarget || target.bunTarget === singleTarget);
  if (!found) failUsage(`unknown target: ${singleTarget}`);
  return [found];
}

function asString(value: string | Buffer | undefined): string {
  if (typeof value === "string") return value;
  if (value) return value.toString("utf-8");
  return "";
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CommandResult {
  const cwd = options.cwd ?? REPO_ROOT;
  const proc = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 300_000,
  });
  return {
    command: [command, ...args],
    cwd,
    status: proc.status,
    signal: proc.signal,
    stdout: asString(proc.stdout),
    stderr: asString(proc.stderr),
    error: proc.error?.message,
  };
}

function commandGate(
  name: string,
  result: CommandResult,
  ok: boolean,
  fields: Partial<GateResult> = {},
): GateResult {
  return {
    name,
    ok,
    kind: "command",
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    ...fields,
  };
}

function actualArtifactFor(requested: string): { artifact: string; note?: string } | null {
  if (existsSync(requested)) return { artifact: requested };
  const windowsExe = `${requested}.exe`;
  if (existsSync(windowsExe)) {
    return {
      artifact: windowsExe,
      note: "Bun appended .exe to the requested Windows outfile.",
    };
  }
  return null;
}

function removeStaleArtifacts(target: TargetConfig): void {
  rmSync(target.artifact, { force: true });
  rmSync(`${target.artifact}.exe`, { force: true });
}

function formatSeconds(ms: number): number {
  return Math.round((ms / 1000) * 1000) / 1000;
}

function stampedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const prefixed = /^aidlc\s+([0-9]+\.[0-9]+\.[0-9]+)$/.exec(trimmed);
  return prefixed?.[1] ?? trimmed;
}

function versionGate(artifact: string): GateResult {
  const result = run(artifact, ["version"], { cwd: tmpdir(), timeoutMs: 30_000 });
  const actual = stampedVersion(result.stdout);
  return commandGate(
    "version",
    result,
    result.status === 0 && !result.error && actual === AIDLC_VERSION,
    {
      expected: AIDLC_VERSION,
      actual,
      detail: "runs from os.tmpdir() and checks the stamped AIDLC version",
    },
  );
}

function helpGate(artifact: string): GateResult {
  const result = run(artifact, ["help"], { cwd: tmpdir(), timeoutMs: 30_000 });
  const firstLine = result.stdout.split(/\r?\n/)[0] ?? "";
  return commandGate(
    "help",
    result,
    result.status === 0 && !result.error && firstLine.toLowerCase().includes("aidlc"),
    {
      expected: "first stdout line contains aidlc",
      actual: firstLine,
      detail: "runs from os.tmpdir() and checks that help reached the dispatcher",
    },
  );
}

function pathlessVersionGate(artifact: string): GateResult {
  const result = run(artifact, ["version"], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: "" },
    timeoutMs: 30_000,
  });
  const actual = stampedVersion(result.stdout);
  return commandGate(
    "pathless-version",
    result,
    result.status === 0 && !result.error && actual === AIDLC_VERSION,
    {
      expected: AIDLC_VERSION,
      actual,
      detail: "runs version with PATH empty to prove the native version path does not need a PATH bun",
    },
  );
}

function markerFreeBunSpawnLine(line: string): boolean {
  if (!line.includes("\"bun\"") && !line.includes("'bun'")) return false;
  if (line.includes(DEV_SPAWN_MARKER)) return false;
  return /\b(?:Bun\.)?spawn(?:Sync)?\b|\bspawnSync\b|\bspawn\b|\bcmd:\s*\[|\[\s*["']bun["']/.test(line);
}

function devSpawnGrepGate(entry: string): GateResult {
  const result = run(process.execPath, ["build", entry, "--target=bun"], {
    cwd: REPO_ROOT,
    timeoutMs: 60_000,
  });
  if (result.status !== 0 || result.error) {
    return commandGate("dev-spawn-grep", result, false, {
      detail: "could not build the text bundle used for dev-spawn inspection",
    });
  }

  const badLines = result.stdout
    .split(/\r?\n/)
    .filter(markerFreeBunSpawnLine)
    .slice(0, 10);
  const markerPresent = result.stdout.includes(DEV_SPAWN_MARKER);
  return {
    name: "dev-spawn-grep",
    ok: badLines.length === 0,
    kind: "inspection",
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    stderr: result.stderr,
    expected: "no marker-free literal bun spawn in the text bundle",
    actual: badLines.length,
    detail:
      `bundleBytes=${result.stdout.length}; markerPresentInBundle=${markerPresent}; ` +
      `badLines=${JSON.stringify(badLines)}; inline comments may be stripped by Bun, ` +
      "so pathless-version is the runtime fallback gate for the native version path",
  };
}

function sizeGate(bytes: number): GateResult {
  return {
    name: "size",
    ok: bytes > MIN_CROSS_BYTES,
    kind: "inspection",
    expected: MIN_CROSS_BYTES + 1,
    actual: bytes,
    detail: "cross artifacts must be larger than 10 MiB",
  };
}

function fileGate(artifact: string, needle: string): GateResult {
  const result = run("file", [artifact], { cwd: REPO_ROOT, timeoutMs: 30_000 });
  return commandGate(
    "file",
    result,
    result.status === 0 && !result.error && result.stdout.includes(needle),
    {
      expected: needle,
      actual: result.stdout.trim(),
      detail: "file(1) target-format smoke for cross artifacts",
    },
  );
}

function buildTarget(target: TargetConfig): TargetResult {
  removeStaleArtifacts(target);

  const args = ["build", ENTRY, "--compile", "--outfile", target.artifact];
  if (target.bunTarget) args.push(`--target=${target.bunTarget}`);

  const start = performance.now();
  const build = run(process.execPath, args, { cwd: REPO_ROOT, timeoutMs: 300_000 });
  const seconds = formatSeconds(performance.now() - start);
  const result: TargetResult = {
    name: target.name,
    bunTarget: target.bunTarget,
    artifact: target.artifact,
    requestedArtifact: target.artifact,
    seconds,
    bytes: 0,
    build,
    gates: [],
  };

  if (build.status !== 0 || build.error) {
    result.gates.push(commandGate("build", build, false, { detail: "bun build --compile failed" }));
    return result;
  }

  const actual = actualArtifactFor(target.artifact);
  if (!actual) {
    result.gates.push({
      name: "artifact-exists",
      ok: false,
      kind: "inspection",
      expected: target.artifact,
      actual: "missing",
      detail: "bun build exited 0 but did not create the requested artifact",
    });
    return result;
  }

  result.artifact = actual.artifact;
  result.artifactNote = actual.note;
  result.bytes = statSync(actual.artifact).size;

  if (target.name === "native") {
    result.gates.push(versionGate(actual.artifact));
    result.gates.push(helpGate(actual.artifact));
    result.gates.push(devSpawnGrepGate(ENTRY));
    result.gates.push(pathlessVersionGate(actual.artifact));
  } else {
    result.gates.push(sizeGate(result.bytes));
    result.gates.push(fileGate(actual.artifact, target.fileNeedle ?? ""));
  }

  return result;
}

function resultFailures(result: TargetResult): string[] {
  const failures: string[] = [];
  if (result.build.status !== 0 || result.build.error) {
    failures.push(`${result.name}: build failed`);
  }
  for (const gate of result.gates) {
    if (!gate.ok) failures.push(`${result.name}: ${gate.name} gate failed`);
  }
  return failures;
}

function writeResults(
  bunVersion: string,
  packageCheck: CommandResult,
  results: TargetResult[],
): void {
  const totalSeconds = formatSeconds(results.reduce((sum, result) => sum + result.seconds * 1000, 0));
  const output = {
    generator: "scripts/build-binaries.ts",
    entry: ENTRY,
    outDir: OUT_DIR,
    bunVersion,
    expectedVersion: AIDLC_VERSION,
    packageCheck,
    nativeOnlySeconds: results.find((result) => result.name === "native")?.seconds ?? 0,
    totalSeconds,
    failures: results.flatMap(resultFailures),
    results,
  };
  writeFileSync(join(OUT_DIR, "build-results.json"), `${JSON.stringify(output, null, 2)}\n`, "utf-8");
}

function tail(text: string, lines = 20): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function main(): void {
  const targets = selectedTargets(process.argv.slice(2));

  const packageCheck = run(process.execPath, ["scripts/package.ts", "--check"], {
    cwd: REPO_ROOT,
    timeoutMs: 300_000,
  });
  if (packageCheck.status !== 0 || packageCheck.error) {
    console.error("package drift guard failed; run bun scripts/package.ts before building binaries");
    const output = tail(`${packageCheck.stdout}${packageCheck.stderr}`);
    if (output) console.error(output);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const bunVersion = run(process.execPath, ["--version"], { cwd: REPO_ROOT, timeoutMs: 30_000 }).stdout.trim();
  const results: TargetResult[] = [];

  for (const target of targets) {
    const result = buildTarget(target);
    results.push(result);
    const ok = resultFailures(result).length === 0 ? "ok" : "FAIL";
    console.log(`${result.name}\t${ok}\t${result.seconds}s\t${result.bytes} bytes\t${result.artifact}`);
  }

  writeResults(bunVersion, packageCheck, results);

  const failures = results.flatMap(resultFailures);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`wrote ${join(OUT_DIR, "build-results.json")}`);
    process.exit(1);
  }

  console.log(`wrote ${join(OUT_DIR, "build-results.json")}`);
}

main();
