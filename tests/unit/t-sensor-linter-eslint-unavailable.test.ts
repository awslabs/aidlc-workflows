// covers: tool:aidlc-sensor-linter

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWithoutCommandOnPath } from "../harness/test-command-paths.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const SHIPPED_SENSORS = join(REPO_ROOT, "dist", "claude", ".claude", "sensors");
const LINTER = join(TOOLS_DIR, "aidlc-sensor-linter.ts");
const DISPATCHER = join(TOOLS_DIR, "aidlc-sensor.ts");
const TIMEOUT_MS = NATIVE_FIXTURE_SETUP_TIMEOUT_MS;
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function project(opts: { config: boolean; ownEslint?: boolean }): { proj: string; file: string } {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-linter-no-eslint-"));
  tempDirs.push(proj);
  writeFileSync(join(proj, "package.json"), '{"name":"fixture","private":true}\n');
  if (opts.config) {
    writeFileSync(join(proj, "eslint.config.mjs"), 'export default [{ rules: { "no-var": "error" } }];\n');
  }
  if (opts.ownEslint) {
    symlinkSync(join(REPO_ROOT, "node_modules"), join(proj, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const file = join(proj, "sample.js");
  writeFileSync(file, "var total = 1;\nconsole.log(total);\n");
  return { proj, file };
}

function noBunxEnv(): NodeJS.ProcessEnv {
  const env = envWithoutCommandOnPath("bunx");
  delete env.NODE_PATH;
  return env;
}

function runLinter(file: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [LINTER, "--stage", "code-generation", "--file-path", file], {
    cwd,
    encoding: "utf-8",
    env,
    timeout: TIMEOUT_MS,
  });
}

function fireLinter(proj: string, file: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [DISPATCHER, "fire", "linter", "--stage", "code-generation", "--output-path", file],
    {
      cwd: proj,
      encoding: "utf-8",
      env: {
        ...env,
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_SENSORS_DIR: SHIPPED_SENSORS,
        AIDLC_SENSOR_SCRIPT_DIR: TOOLS_DIR,
      },
      timeout: TIMEOUT_MS,
    },
  );
}

function auditField(proj: string, event: string, key: string): string {
  let matched = false;
  for (const line of readAllAuditShards(proj).split("\n")) {
    if (line.startsWith("## ") || line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${event}`;
      continue;
    }
    if (matched && line.startsWith(`**${key}**: `)) return line.slice(`**${key}**: `.length);
  }
  return "";
}

function auditEventCount(proj: string, event: string): number {
  return readAllAuditShards(proj)
    .split("\n")
    .filter((line) => line === `**Event**: ${event}`).length;
}

describe("t-sensor-linter-eslint-unavailable: a config with no ESLint to run it", () => {
  test("the linter says it could not run, naming the reason and the remedy, instead of claiming tool-unavailable", () => {
    const { proj, file } = project({ config: true });
    const env = noBunxEnv();
    expect(Bun.which("bunx", { PATH: env.PATH })).toBeNull();
    const res = runLinter(file, proj, env);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("tool-unavailable: no ESLint is available to lint this file");
    expect(res.stderr).toContain("bunx is not on PATH");
    expect(res.stderr).toContain("Install ESLint in the project");
    expect(res.stderr).toContain("copy install");
  }, TIMEOUT_MS);

  test("the dispatcher records it as could not run, so the gate says it and the audit names why", () => {
    const { proj, file } = project({ config: true });
    const res = fireLinter(proj, file, noBunxEnv());
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(auditEventCount(proj, "SENSOR_FIRED")).toBe(1);
    expect(auditEventCount(proj, "SENSOR_PASSED")).toBe(0);
    expect(auditEventCount(proj, "SENSOR_FAILED")).toBe(0);
    expect(auditEventCount(proj, "SENSOR_COULD_NOT_RUN")).toBe(1);
    const note = auditField(proj, "SENSOR_COULD_NOT_RUN", "Note");
    expect(note).toStartWith("tool-unavailable: ");
    expect(note).toContain("Install ESLint in the project, or use a copy install, which ships bunx.");
    const verdict = JSON.parse(res.stdout.trim().split("\n").at(-1) as string);
    expect(verdict.result).toBe("could-not-run");
    expect(verdict.note).toBe(note);
  }, TIMEOUT_MS);

  test("a file no config governs still passes with tool-unavailable: there is nothing to check", () => {
    const { proj, file } = project({ config: false });
    const res = runLinter(file, proj, noBunxEnv());
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(127);
    expect(res.stderr).toContain("eslint-unavailable");
  }, TIMEOUT_MS);

  test("an ESLint that does run reports its finding, unchanged", () => {
    const { proj, file } = project({ config: true, ownEslint: true });
    const res = runLinter(file, proj, noBunxEnv());
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    const verdict = JSON.parse(res.stdout);
    expect(verdict.pass).toBe(false);
    expect(verdict.errorCount).toBe(1);
    expect(verdict.violations[0].rule).toBe("no-var");
  }, TIMEOUT_MS);
});
