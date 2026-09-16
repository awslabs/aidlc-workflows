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
  test("fresh scaffold renders eight rows, one gate, and decline changes no section state", () => {
    const path = project("aidlc-t296-map-decline-");
    const result = run(
      scaffoldArgs(path),
      path,
      hookPathEnv(null, true),
      "n\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Setup check - 3 of 8 sections need you.");
    expect(setupRows(result.stdout)).toHaveLength(8);
    for (const label of [
      "Harnesses",
      "Models",
      "Trust",
      "Flags",
      "Project",
      "Runtime",
      "Providers",
      "Workspace",
    ]) {
      expect(setupRows(result.stdout).some((line) => line.includes(label))).toBe(true);
    }
    expect(setupRows(result.stdout).find((line) => line.includes("Workspace")))
      .toContain("[ok]");
    expect(setupRows(result.stdout).find((line) => line.includes("Runtime")))
      .toContain("[needs]");
    expect(setupRows(result.stdout).find((line) => line.includes("Providers")))
      .toContain("[needs]");
    // A scaffold records no model policy, so every agent would silently inherit
    // the session's effort. The row says so and the walk offers the section.
    expect(setupRows(result.stdout).find((line) => line.includes("Models")))
      .toContain("[needs]");
    expect(result.stdout).toContain(
      "no recorded policy; agents inherit your session model and effort",
    );
    expect(result.stdout.match(/Fix the 3 sections that need you now\?/g))
      .toHaveLength(1);
    expect(result.stdout).not.toContain("Outstanding actions:");
    expect(result.stdout).toContain("Setup complete. 3 actions still need you");
    expect(result.stdout).toContain(
      "runtime      bun .claude/tools/aidlc.ts config runtime",
    );
    expect(result.stdout).toContain(
      "models       bun .claude/tools/aidlc.ts config models",
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

  test("a Bedrock-oriented harness gets the model-preset step's unchanged answer", () => {
    const path = project("aidlc-t296-walk-unchanged-");
    const env = hookPathEnv("aidlc", true, {
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    });
    // Decline the walk, then drive the section directly: the walk opens the
    // model-preset step first, and its output would be scored by the
    // no-vendor-names assertions below that only the provider menu owns.
    expect(run(scaffoldArgs(path), path, env, "n\n").status).toBe(0);
    // 2 = unchanged, which records nothing and keeps what is in place.
    const result = run(
      ["config", "providers", "--project-dir", path, "--harness", "claude"],
      path,
      env,
      "2\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // Bedrock names what it writes for THIS harness. There is no `builtin` here:
    // Claude Code does not serve its own models, and naming a vendor would be a
    // guess, since it also runs on Vertex.
    expect(result.stdout).toContain(
      "1. amazon-bedrock   records the AWS region and profile in settings.json",
    );
    expect(result.stdout).toContain(
      "2. unchanged        records no provider answer and keeps existing settings;",
    );
    expect(result.stdout).toContain("new projects use the shipped fallback");
    expect(result.stdout).not.toContain("builtin");
    // `other` is flag-only now: nothing read a recorded `other`, and declining
    // its acknowledgement did exactly what `unchanged` does. Match the numbered
    // answer and the old acknowledgement prompt, not any word containing "other".
    expect(result.stdout).not.toMatch(/\d\. other\b/);
    expect(result.stdout).not.toContain("Using other provider setup");
    for (const vendor of ["Anthropic", "OpenAI", "Vertex", "subscription"]) {
      expect(result.stdout).not.toContain(vendor);
    }
    expect(result.stdout).toContain(
      "Keeping existing settings unchanged; no provider answer recorded.",
    );
    expect(result.stdout).not.toContain("Manual provider setup complete?");
    expect(readConfigDiagnosticRecords(join(path, ".claude")).providers).toBeNull();
  }, 90_000);

  test("Kiro's providers section asks nothing and records nothing", () => {
    const path = project("aidlc-t296-walk-kiro-managed-");
    const env = hookPathEnv("aidlc", true, {
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    });
    const kiroScaffold = [
      "config",
      "--project-dir",
      path,
      "--from",
      join(REPO_ROOT, "dist-release", "kiro"),
      "--harness",
      "kiro",
      "--mcp",
      "none",
      "--yes",
    ];
    // Naming the section explicitly still has no provider question to ask.
    expect(run(kiroScaffold, path, env, "n\n").status).toBe(0);
    const section = run(
      ["config", "providers", "--project-dir", path, "--harness", "kiro"],
      path,
      env,
    );
    expect(section.status, section.stdout + section.stderr).toBe(0);
    expect(section.stdout).toContain(
      "Model access comes with Kiro CLI; AI-DLC configures no model provider for it.",
    );
    expect(section.stdout).toContain("Nothing to answer");
    expect(section.stdout).not.toContain("Provider [");
    expect(section.stdout).not.toContain("builtin");
    expect(section.stdout).not.toContain("amazon-bedrock");
    expect(readConfigDiagnosticRecords(join(path, ".kiro")).providers).toBeNull();
    // The fact is human prose only: `--json` must stay one parseable object and
    // `--quiet` one line, and a non-TTY caller gets the same answer without a
    // usage error.
    const asJson = run(
      ["config", "providers", "--project-dir", path, "--harness", "kiro", "--json"],
      path,
      env,
    );
    expect(asJson.status, asJson.stdout + asJson.stderr).toBe(0);
    expect(asJson.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(asJson.stdout)).toEqual(expect.objectContaining({
      ok: true,
      message: "providers needs no answer for kiro; its model access is harness-managed",
    }));
    const quiet = run(
      ["config", "providers", "--project-dir", path, "--harness", "kiro", "--quiet"],
      path,
      env,
    );
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(quiet.stdout.trim().split("\n")).toEqual([
      "providers needs no answer for kiro; its model access is harness-managed",
    ]);
    const nonTty = run(
      ["config", "providers", "--project-dir", path, "--harness", "kiro"],
      path,
      hookPathEnv("aidlc", false),
    );
    expect(nonTty.status, nonTty.stdout + nonTty.stderr).toBe(0);
    expect(nonTty.stdout).toContain("Nothing to answer");
    expect(nonTty.stdout).not.toContain("non-interactive providers configuration requires");
  }, 90_000);

  test("a subscription harness needs no provider answer and is not chased for one", () => {
    const path = project("aidlc-t296-kiro-managed-");
    // Credentials present on purpose: on Kiro they say nothing about which model
    // the harness uses, so the row must still read [ok] and Bedrock must not lead.
    const env = hookPathEnv("aidlc", true, {
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    });
    const result = run(
      [
        "config",
        "--project-dir",
        path,
        "--from",
        join(REPO_ROOT, "dist-release", "kiro"),
        "--harness",
        "kiro",
        "--mcp",
        "none",
        "--yes",
      ],
      path,
      env,
      "n\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(setupRows(result.stdout).find((line) => line.includes("Providers")))
      .toContain("[ok]");
    expect(result.stdout).toContain(
      "model access comes with Kiro CLI; nothing for AI-DLC to configure",
    );
    expect(result.stdout).not.toContain("provider access unverified");
    expect(result.stdout).not.toContain("Choose and configure a model provider");
    expect(result.stdout).not.toContain("config providers");
    // Never asked, so detected AWS credentials cannot mislead the answer.
    expect(result.stdout).not.toContain("Provider [");
    expect(readConfigDiagnosticRecords(join(path, ".kiro")).providers).toBeNull();

    // Close the model-policy row so a provider chase cannot hide in another gate.
    const models = run([
      "config", "models", "--project-dir", path, "--preset", "balanced", "--yes",
    ], path, env);
    expect(models.status, models.stdout + models.stderr).toBe(0);
    const dataPath = join(path, ".kiro", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    data.providers = {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-west-2",
      pendingActions: [
        { id: "bedrock-model-access", status: "pending" },
        { id: "kiro-ide-chat-model", status: "pending" },
      ],
    };
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    const walk = run(["config", "--project-dir", path], path, env);
    expect(walk.status, walk.stdout + walk.stderr).toBe(0);
    const providers = setupRows(walk.stdout).find((line) => line.includes("Providers"));
    expect(providers).toContain("[ok]");
    expect(providers).toContain(
      "model access comes with Kiro CLI; nothing for AI-DLC to configure",
    );
    expect(walk.stdout).not.toContain("Fix the");
    expect(walk.stdout).not.toContain("config providers");
    expect(walk.stdout).not.toContain("Provider [");
  }, 60_000);

  test("an incomplete workspace shell is reported once, never walked, with the command that rebuilds it", () => {
    const path = project("aidlc-t296-shell-missing-");
    const env = hookPathEnv("aidlc", true);
    expect(run(scaffoldArgs(path), path, env, "n\n").status).toBe(0);
    // Reproduce a partial copy: the harness tree arrived, the workspace did not.
    rmSync(join(path, "aidlc"), { recursive: true, force: true });
    // "y" would accept the gate if one were offered; it must not be.
    const rerun = run(
      ["config", "--project-dir", path],
      path,
      env,
      "y\n",
    );
    expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
    expect(setupRows(rerun.stdout).find((line) => line.includes("Workspace")))
      .toContain("[needs]");
    expect(rerun.stdout).toContain(
      "aidlc/spaces/default/memory/ is missing; the shell is incomplete",
    );
    // One defect, one row: the Trust section's own `workspace-root-missing`
    // issue is folded into the Workspace row instead of flagging Trust too.
    expect(setupRows(rerun.stdout).find((line) => line.includes("Trust")))
      .toContain("[ok]");
    expect(rerun.stdout).toContain("Setup check - 3 of 8 sections need you.");
    // Reported, never walked: while the shell is incomplete no gate is offered,
    // because every walkable section would fail on the missing directory or,
    // with no-op answers, rebuild nothing.
    expect(rerun.stdout).not.toContain("Fix the");
    expect(rerun.stdout).toContain(
      "The workspace shell is incomplete, so no section is walked until it is rebuilt",
    );
    // The old advice was a bare `aidlc config`, which is this very command. This
    // is a Bun-invoking projection, which has no installed runtime to refresh
    // from, so the rebuild also names the source bytes: the copy-runtime root or a
    // checkout's dist tree, never the native bytes that would swap its channel.
    expect(rerun.stdout).toMatch(
      /workspace\s+bun \.claude\/tools\/aidlc\.ts config --harness claude --from <the runtime\/claude\/ root you copied from, or a checkout's dist\/claude\/ tree>/,
    );
    expect(rerun.stdout).not.toMatch(/^\s+trust\s+/m);
    // The trust issue itself now names the same rebuild, not the bare rerun.
    const trust = run(
      ["config", "trust", "--project-dir", path, "--show", "--json"],
      path,
      env,
    );
    expect(trust.status, trust.stdout + trust.stderr).toBe(0);
    const issues = JSON.parse(trust.stdout).data.issues as Array<{
      id: string;
      remediation: string;
    }>;
    expect(issues.map((issue) => issue.id)).toEqual(["workspace-root-missing"]);
    expect(issues[0].remediation).toContain(
      "bun .claude/tools/aidlc.ts config --harness claude --from <the runtime/claude/ root you copied from, or a checkout's dist/claude/ tree>",
    );
    expect(issues[0].remediation).not.toContain("Run aidlc config to restore");
  }, 90_000);

  test("a shell missing only its memory dir keeps the Workspace row through an accepted walk", () => {
    const path = project("aidlc-t296-memory-missing-");
    const env = hookPathEnv("aidlc", true);
    expect(run(scaffoldArgs(path), path, env, "n\n").status).toBe(0);
    // Only the default space's memory dir is gone: the `aidlc/` root exists, so
    // Trust has nothing to say and the record-only children would succeed as
    // no-ops without rebuilding anything. The closing ledger used to recompute
    // itself without the shell and lose the Workspace row here.
    rmSync(join(path, "aidlc", "spaces", "default", "memory"), {
      recursive: true,
      force: true,
    });
    const rerun = run(
      ["config", "--project-dir", path],
      path,
      env,
      "y\n\n\n2\n",
    );
    expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
    expect(setupRows(rerun.stdout).find((line) => line.includes("Workspace")))
      .toContain("[needs]");
    expect(setupRows(rerun.stdout).find((line) => line.includes("Trust")))
      .toContain("[ok]");
    expect(rerun.stdout).toContain("Setup check - 3 of 8 sections need you.");
    expect(rerun.stdout).not.toContain("Fix the");
    expect(rerun.stdout).toMatch(
      /workspace\s+bun \.claude\/tools\/aidlc\.ts config --harness claude/,
    );
    expect(existsSync(join(path, "aidlc", "spaces", "default", "memory"))).toBe(false);
  }, 60_000);

  test("yes walks models then providers, applies answers without double confirm, and closes clean", () => {
    const path = project("aidlc-t296-walk-provider-");
    const env = hookPathEnv("aidlc", true, {
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    });
    // Models is walked first now: settings layer, then 1 to pick a preset, then
    // balanced. Providers follows with region and profile. Recording the preset
    // is the point of the walk: without it every agent inherits the session.
    const result = run(
      scaffoldArgs(path),
      path,
      env,
      "\nproject\n1\nbalanced\n\nus-west-2\ndev\ny\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Setup check - 2 of 8 sections need you.");
    expect(setupRows(result.stdout).find((line) => line.includes("Runtime")))
      .toContain("[ok]");
    expect(setupRows(result.stdout).find((line) => line.includes("Models")))
      .toContain("[needs]");
    expect(setupRows(result.stdout).find((line) => line.includes("Providers")))
      .toContain("[needs]");
    expect(result.stdout).toContain("Model policy for claude");
    expect(result.stdout).toContain("Provider [1]:");
    expect(result.stdout).not.toContain("Apply providers configuration changes?");
    expect(result.stdout).not.toContain("Runtime configuration for");
    expect(result.stdout).not.toContain("Trust configuration for");
    expect(result.stdout).not.toContain("Outstanding actions:");
    expect(result.stdout).toContain("Setup complete. 0 actions still need you");
    // The recorded preset is what closes the row; a declined walk would leave it
    // open and the ledger would name the command instead.
    expect(readFileSync(join(path, "aidlc.settings.json"), "utf-8"))
      .toContain('"preset": "balanced"');

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
    expect(rerun.stdout).toContain("Setup check - 0 of 8 sections need you.");
    expect(setupRows(rerun.stdout)).toHaveLength(8);
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
    expect(runtimeWalk.stdout).toContain("Setup check - 1 of 8 sections need you.");
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

  test("section --show --quiet emits one line instead of the human report", () => {
    const path = project("aidlc-t296-show-quiet-");
    const env = hookPathEnv("aidlc", false);
    const scaffold = run(scaffoldArgs(path), path, env);
    expect(scaffold.status, scaffold.stdout + scaffold.stderr).toBe(0);
    const expected: Array<[string, string]> = [
      ["runtime", "runtime configuration for claude"],
      ["providers", "providers configuration for claude"],
      ["trust", "trust configuration for claude"],
      ["models", "model policy for claude"],
      ["flags", "flags configuration for claude"],
      ["project", "project configuration for claude"],
    ];
    for (const [section, line] of expected) {
      const quiet = run(
        ["config", section, "--project-dir", path, "--show", "--quiet"],
        path,
        env,
      );
      expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
      // One line, the same message the JSON result carries; the human report
      // (heading plus indented detail lines) must not leak under --quiet.
      expect(quiet.stdout.trimEnd().split(/\r?\n/), section).toEqual([line]);
    }
  }, 120_000);
});
