// covers: tool:aidlc-sensor-type-check
//
// t-sensor-type-check-native - on a native install the type-check sensor checks
// types with the project's own TypeScript, under Node, and fetches nothing.
//
// A native install ships no bunx, so the pinned `bunx --package typescript@6 tsc`
// cannot start there and every fire read tool-unavailable, even in a project
// with its own TypeScript. The native executable is never run as Bun to fetch
// one (the linter's ESLint fallback made the same choice). Cases run on Linux,
// macOS and Windows; the copy-channel argv pin needs a sh shim, so not on Windows.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { envWithoutCommandOnPath } from "../harness/test-command-paths.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-sensor-type-check.ts");
const REPO_TYPESCRIPT = join(REPO_ROOT, "node_modules", "typescript");
const TIMEOUT_MS = 120_000;
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function project(typescript: "repo" | "none" | "3.9.10"): { proj: string; file: string } {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t-type-check-native-"));
  tempDirs.push(proj);
  writeFileSync(join(proj, "package.json"), '{"name":"fixture","private":true}\n');
  writeFileSync(
    join(proj, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"noEmit":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}\n',
  );
  mkdirSync(join(proj, "src"));
  const file = join(proj, "src", "bad.ts");
  writeFileSync(file, 'export const n: number = "not a number";\n');
  if (typescript === "repo") {
    mkdirSync(join(proj, "node_modules"));
    symlinkSync(REPO_TYPESCRIPT, join(proj, "node_modules", "typescript"), "junction");
  } else if (typescript === "3.9.10") {
    // A TypeScript older than 4 rejects the sensor's --incremental beside a
    // noEmit tsconfig with an error the per-file filter drops; this stand-in
    // would read as a clean pass if the sensor ran it.
    const pkg = join(proj, "node_modules", "typescript");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"typescript","version":"3.9.10"}\n');
    writeFileSync(join(pkg, "bin", "tsc"), "process.exit(0);\n");
  }
  return { proj, file };
}

// A native install: the dispatcher names its executable, and bunx is nowhere on PATH.
function nativeEnv(proj: string): NodeJS.ProcessEnv {
  const env = envWithoutCommandOnPath("bunx");
  env.AIDLC_COMPILED_EXECUTABLE = join(proj, "aidlc-native-stand-in");
  env.AIDLC_PROJECT_DIR = proj;
  return env;
}

function runSensor(file: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, "--stage", "code-generation", "--file-path", file], {
    cwd,
    encoding: "utf-8",
    env,
    timeout: TIMEOUT_MS,
  });
}

describe("t-sensor-type-check-native: a native install checks types without Bun", () => {
  test("the project's own TypeScript reports the type error, with no bunx on PATH", () => {
    const { proj, file } = project("repo");
    const env = nativeEnv(proj);
    expect(Bun.which("bunx", { PATH: env.PATH })).toBeNull();
    expect(Bun.which("node", { PATH: env.PATH }), "this case needs Node on PATH, as the project's own ESLint does").not.toBeNull();
    const res = runSensor(file, proj, env);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    const verdict = JSON.parse(res.stdout);
    expect(verdict.pass).toBe(false);
    expect(verdict.findings_count).toBe(1);
    expect(verdict.errors[0].line).toBe(1);
    expect(verdict.errors[0].message).toContain("not assignable to type 'number'");
  }, TIMEOUT_MS);

  test("a project with no TypeScript of its own still reads tool-unavailable", () => {
    const { proj, file } = project("none");
    const res = runSensor(file, proj, nativeEnv(proj));
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(127);
    expect(res.stderr).toContain("tsc-unavailable");
  }, TIMEOUT_MS);

  test("a TypeScript older than 4 is not run, so it cannot pass a file it never checked", () => {
    const { proj, file } = project("3.9.10");
    const res = runSensor(file, proj, nativeEnv(proj));
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(127);
    expect(res.stderr).toContain("tsc-unavailable");
  }, TIMEOUT_MS);

  test.skipIf(process.platform === "win32")("a copy install runs the pinned bunx command as before, even beside the project's own TypeScript", () => {
    const { proj, file } = project("repo");
    const bin = mkdtempSync(join(tmpdir(), "aidlc-t-type-check-bunx-"));
    tempDirs.push(bin);
    const log = join(bin, "bunx.log");
    writeFileSync(join(bin, "bunx"), `#!/bin/sh\necho "$*" >> "${log}"\nexit 0\n`);
    chmodSync(join(bin, "bunx"), 0o755);
    const { AIDLC_COMPILED_EXECUTABLE: _native, ...rest } = process.env;
    const env = { ...rest, AIDLC_PROJECT_DIR: proj, PATH: `${bin}${delimiter}${process.env.PATH}` };
    const res = runSensor(file, proj, env);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    const calls = readFileSync(log, "utf-8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("--package typescript@6 tsc --version");
    expect(calls[1]).toStartWith(`--package typescript@6 tsc --project ${join(proj, "tsconfig.json")} --noEmit --pretty false --incremental --tsBuildInfoFile `);
  }, TIMEOUT_MS);
});
