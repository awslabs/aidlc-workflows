// covers: file:scripts/build-binaries.ts, tool:aidlc, subcommand:aidlc-utility:version
//
// Native-only unit coverage for the release binary builder. The cross-target
// matrix, including Bun's Windows .exe append behavior, is intentionally left
// to release CI because those artifacts are host/toolchain dependent and much
// more expensive than the local native gate.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../../dist/claude/.claude/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build-binaries.ts");
const RESULTS_JSON = join(REPO_ROOT, "build", "binaries", "build-results.json");
const UTILITY_TS = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type GateResult = {
  name: string;
  ok: boolean;
  actual?: string | number;
  expected?: string | number;
};

type TargetResult = {
  name: string;
  artifact: string;
  bytes: number;
  gates: GateResult[];
};

type BuildResults = {
  expectedVersion: string;
  results: TargetResult[];
};

function runBuild(extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_BUILD_ENTRY;
  delete env.AIDLC_BUILD_OUT_DIR;
  Object.assign(env, extraEnv);
  const result = spawnSync(BUN, [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env,
    timeout: 300_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function readResults(path = RESULTS_JSON): BuildResults {
  return JSON.parse(readFileSync(path, "utf-8")) as BuildResults;
}

function nativeResult(doc: BuildResults): TargetResult {
  const native = doc.results.find((result) => result.name === "native");
  expect(native).toBeDefined();
  return native as TargetResult;
}

function gate(result: TargetResult, name: string): GateResult {
  const found = result.gates.find((item) => item.name === name);
  expect(found).toBeDefined();
  return found as GateResult;
}

function stampedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const prefixed = /^aidlc\s+([0-9]+\.[0-9]+\.[0-9]+)$/.exec(trimmed);
  return prefixed?.[1] ?? trimmed;
}

describe("t231 build-binaries release builder", () => {
  test("native build compiles, gates, records results, and reruns version from /tmp", () => {
    const result = runBuild();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const doc = readResults();
    expect(doc.expectedVersion).toBe(AIDLC_VERSION);
    const native = nativeResult(doc);
    expect(existsSync(native.artifact)).toBe(true);
    expect(relative(REPO_ROOT, native.artifact).replace(/\\/g, "/").startsWith("build/binaries/")).toBe(true);
    expect(native.bytes).toBeGreaterThan(10 * 1024 * 1024);

    const version = gate(native, "version");
    expect(version.ok).toBe(true);
    expect(version.actual).toBe(AIDLC_VERSION);

    const rerun = spawnSync(native.artifact, ["version"], {
      cwd: tmpdir(),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(rerun.status).toBe(0);
    expect(stampedVersion(rerun.stdout ?? "")).toBe(AIDLC_VERSION);

    const utility = spawnSync(BUN, [UTILITY_TS, "version"], {
      cwd: tmpdir(),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(utility.status).toBe(0);
    expect(stampedVersion(utility.stdout ?? "")).toBe(AIDLC_VERSION);
  }, 300_000);

  test("fake entry with wrong version proves the mandatory version gate can fail", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-t231-"));
    try {
      const entry = join(root, "fake-aidlc.ts");
      const outDir = join(root, "out");
      writeFileSync(
        entry,
        [
          "#!/usr/bin/env bun",
          "const verb = process.argv[2];",
          "if (verb === \"version\") {",
          "  process.stdout.write(\"aidlc 0.0.0\\n\");",
          "  process.exit(0);",
          "}",
          "if (verb === \"help\" || verb === undefined) {",
          "  process.stdout.write(\"aidlc fake help\\n\");",
          "  process.exit(0);",
          "}",
          "process.stderr.write(\"unknown fake command\\n\");",
          "process.exit(2);",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = runBuild({
        AIDLC_BUILD_ENTRY: entry,
        AIDLC_BUILD_OUT_DIR: outDir,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version gate failed");

      const doc = readResults(join(outDir, "build-results.json"));
      const native = nativeResult(doc);
      const version = gate(native, "version");
      expect(version.ok).toBe(false);
      expect(version.actual).toBe("0.0.0");
      expect(version.expected).toBe(AIDLC_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
