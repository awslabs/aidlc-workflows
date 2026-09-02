// covers: tool:aidlc-init, function:postApplyOutstandingActions

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { readConfigDiagnosticRecords } from "../../core/tools/aidlc-config-diagnostics.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function writeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function hookPathEnv(
  command: "aidlc" | null,
  interactive: boolean,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const bin = temp("aidlc-t296-hook-path-");
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "powershell.cmd"),
      `@echo off\r\necho ${bin}\r\n`,
      "utf-8",
    );
  } else {
    writeFileSync(
      join(bin, "getconf"),
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(bin)}\n`,
      { mode: 0o755 },
    );
  }
  if (command) {
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${command}.cmd`), "@exit /b 0\r\n", "utf-8");
    } else {
      for (const name of [command, `${command}.exe`, `${command}.cmd`]) {
        writeExecutable(join(bin, name));
      }
    }
  }
  return {
    PATH: bin,
    ...(process.platform === "win32" ? {} : { SystemRoot: "" }),
    AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist-release"),
    ...(interactive ? { AIDLC_TEST_CONFIG_TTY: "1" } : {}),
    ...extra,
  };
}

function project(prefix: string): string {
  const path = temp(prefix);
  mkdirSync(join(path, ".git"));
  return path;
}

function scaffoldArgs(path: string, extra: string[] = []): string[] {
  return [
    "config",
    "--project-dir",
    path,
    "--from",
    CLAUDE_RELEASE,
    "--harness",
    "claude",
    "--mcp",
    "none",
    "--yes",
    ...extra,
  ];
}

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input = "",
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [INIT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function setupRows(output: string): string[] {
  return output.split(/\r?\n/).filter((line) =>
    /^\s+\[(?:ok|needs)\]/.test(line)
  );
}

describe("t296 first-run config setup walk", () => {
  test("fresh scaffold renders seven rows, one gate, and decline changes no section state", () => {
    const path = project("aidlc-t296-map-decline-");
    const result = run(
      scaffoldArgs(path),
      path,
      hookPathEnv(null, true),
      "n\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Setup check - 2 of 7 sections need you.");
    expect(setupRows(result.stdout)).toHaveLength(7);
    for (const label of [
      "Harnesses",
      "Models",
      "Trust",
      "Flags",
      "Project",
      "Runtime",
      "Providers",
    ]) {
      expect(setupRows(result.stdout).some((line) => line.includes(label))).toBe(true);
    }
    expect(setupRows(result.stdout).find((line) => line.includes("Runtime")))
      .toContain("[needs]");
    expect(setupRows(result.stdout).find((line) => line.includes("Providers")))
      .toContain("[needs]");
    expect(result.stdout.match(/Fix the 2 sections that need you now\?/g))
      .toHaveLength(1);
    expect(result.stdout).not.toContain("Outstanding actions:");
    expect(result.stdout).toContain("Setup complete. 2 actions still need you");
    expect(result.stdout).toContain(
      "runtime      bun .claude/tools/aidlc.ts config runtime",
    );
    expect(result.stdout).toContain(
      "providers    bun .claude/tools/aidlc.ts config providers",
    );
    expect(result.stdout.match(/aidlc is absent from the non-interactive hook PATH/g))
      .toHaveLength(1);
    expect(result.stdout.match(/no recorded answers; provider access unverified/g))
      .toHaveLength(1);
    const records = readConfigDiagnosticRecords(join(path, ".claude"));
    expect(records.runtime).toBeNull();
    expect(records.providers).toBeNull();
    expect(records.trust).toBeNull();
  }, 60_000);

  test("yes walks only providers, applies answers without double confirm, and closes clean", () => {
    const path = project("aidlc-t296-walk-provider-");
    const env = hookPathEnv("aidlc", true, {
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    });
    const result = run(
      scaffoldArgs(path),
      path,
      env,
      "\n\nus-west-2\ndev\ny\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Setup check - 1 of 7 sections need you.");
    expect(setupRows(result.stdout).find((line) => line.includes("Runtime")))
      .toContain("[ok]");
    expect(setupRows(result.stdout).find((line) => line.includes("Providers")))
      .toContain("[needs]");
    expect(result.stdout).toContain("Provider [1]:");
    expect(result.stdout).not.toContain("Apply providers configuration changes?");
    expect(result.stdout).not.toContain("Runtime configuration for");
    expect(result.stdout).not.toContain("Trust configuration for");
    expect(result.stdout).not.toContain("Outstanding actions:");
    expect(result.stdout).toContain("Setup complete. 0 actions still need you");

    const records = readConfigDiagnosticRecords(join(path, ".claude"));
    expect(records.providers).toEqual(expect.objectContaining({
      provider: "amazon-bedrock",
      region: "us-west-2",
      profile: "dev",
      pendingActions: [
        { id: "bedrock-model-access", status: "done" },
      ],
    }));
    const settings = readFileSync(join(path, ".claude", "settings.json"), "utf-8");
    expect(settings).toContain('"AWS_REGION": "us-west-2"');
    expect(settings).toContain('"AWS_PROFILE": "dev"');

    const rerun = run(
      [
        "config",
        "--project-dir",
        path,
        "--from",
        CLAUDE_RELEASE,
        "--yes",
      ],
      path,
      env,
    );
    expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain("Setup check - 0 of 7 sections need you.");
    expect(setupRows(rerun.stdout)).toHaveLength(7);
    expect(rerun.stdout).not.toContain("Fix the");

    const runtimeWalk = run(
      [
        "config",
        "--project-dir",
        path,
        "--from",
        CLAUDE_RELEASE,
        "--yes",
      ],
      path,
      hookPathEnv(null, true),
      "\n",
    );
    expect(runtimeWalk.status, runtimeWalk.stdout + runtimeWalk.stderr).toBe(0);
    expect(runtimeWalk.stdout).toContain("Setup check - 1 of 7 sections need you.");
    expect(runtimeWalk.stdout).not.toContain("Outstanding actions:");
    expect(runtimeWalk.stdout).toContain("Setup complete. 1 action still needs you");
    expect(runtimeWalk.stdout).toContain(
      "Full diagnostics: bun .claude/tools/aidlc.ts config runtime --show",
    );
  }, 60_000);

  test("non-TTY human output is byte-identical to the pre-walk completion", () => {
    const path = project("aidlc-t296-nontty-snapshot-");
    const result = run(
      scaffoldArgs(path),
      path,
      hookPathEnv("aidlc", false),
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `configured ${path} for Claude Code ${AIDLC_VERSION}; ` +
        "next: open Claude Code in this project and run `/aidlc --doctor`\n",
    );
  }, 60_000);

  test("json, quiet, and dry-run never render the setup map", () => {
    const jsonProject = project("aidlc-t296-json-");
    const json = run(
      scaffoldArgs(jsonProject, ["--json"]),
      jsonProject,
      hookPathEnv("aidlc", true),
    );
    expect(json.status, json.stdout + json.stderr).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(json.stdout).not.toContain("Setup check -");

    const quietProject = project("aidlc-t296-quiet-");
    const quiet = run(
      scaffoldArgs(quietProject, ["--quiet"]),
      quietProject,
      hookPathEnv("aidlc", true),
    );
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(quiet.stdout.trim().split("\n")).toHaveLength(1);
    expect(quiet.stdout).not.toContain("Setup check -");

    const dryProject = project("aidlc-t296-dry-");
    const dry = run(
      scaffoldArgs(dryProject, ["--dry-run"]),
      dryProject,
      hookPathEnv(null, true),
    );
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout).not.toContain("Setup check -");
    expect(existsSync(join(dryProject, ".claude"))).toBe(false);
  }, 60_000);
});
