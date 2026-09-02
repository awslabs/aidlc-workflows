// covers: tool:aidlc-init

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { binRoot } from "../../core/tools/aidlc-install-paths.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const RUNTIME = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function executable(path: string, output = ""): void {
  writeFileSync(
    path,
    `#!/bin/sh\n${output ? `printf '%s\\n' ${JSON.stringify(output)}` : "exit 0"}\n`,
    { mode: 0o755 },
  );
}

function treeSnapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(path).isDirectory()) {
        snapshot[`${rel}/`] = "";
        visit(path, rel);
      } else {
        snapshot[rel] = readFileSync(path).toString("base64");
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function detection(
  bin: string,
  harnesses: Record<string, { found: boolean; version?: string }> = {
    claude: { found: true, version: "claude 2.1.220" },
  },
  runtimeIssue = false,
): string {
  return JSON.stringify({
    harnesses: Object.fromEntries(
      Object.entries(harnesses).map(([name, value]) => [
        name,
        {
          ...value,
          ...(value.found ? { path: join(bin, name === "kiro" ? "kiro-cli" : name) } : {}),
        },
      ]),
    ),
    aws: {
      hasCredentials: true,
      sources: ["instance role"],
      profiles: [],
      regions: ["us-east-2"],
      files: [],
    },
    runtimeIssues: runtimeIssue
      ? [{
          id: "runtime-aidlc-missing",
          message: "aidlc is absent from the non-interactive hook PATH",
          remediation: "Add ~/.local/bin to PATH.",
        }]
      : [],
    bedrockReachable: true,
  });
}

function runWizard(
  input: string,
  options: {
    harnesses?: Record<string, { found: boolean; version?: string }>;
    aidlc?: boolean;
    runtimeIssue?: boolean;
    env?: NodeJS.ProcessEnv;
    prepare?: (project: string) => void;
  } = {},
): { project: string; status: number; stdout: string; stderr: string } {
  const project = temp("aidlc-t299-project-");
  const bin = temp("aidlc-t299-bin-");
  mkdirSync(join(project, ".git"));
  executable(join(bin, "claude"), "claude 2.1.220");
  for (const [name, value] of Object.entries(options.harnesses ?? {})) {
    if (!value.found || name === "claude" || name === "kiro-ide") continue;
    executable(
      join(bin, name === "kiro" ? "kiro-cli" : name),
      value.version ?? `${name} 1.0.0`,
    );
  }
  executable(join(bin, "getconf"), bin);
  if (options.aidlc !== false) executable(join(bin, "aidlc"));
  options.prepare?.(project);
  const result = spawnSync(
    BUN,
    [INIT, "config", "--project-dir", project],
    {
      cwd: project,
      env: {
        ...process.env,
        PATH: bin,
        AIDLC_RUNTIME_ROOT: RUNTIME,
        AIDLC_TEST_CONFIG_TTY: "1",
        AIDLC_TEST_CONFIG_DETECTION_JSON: detection(
          bin,
          options.harnesses,
          options.runtimeIssue,
        ),
        ...options.env,
      },
      input,
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
  return {
    project,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("t299 first-run setup wizard", () => {
  test("recommended defaults render detection, trichotomy, receipts, blocker, and next commands", () => {
    const result = runWizard("\n", { aidlc: false, runtimeIssue: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("AI-DLC setup - first run in this project.");
    expect(result.stdout).toContain("Claude Code detected  (2.1.220 on your PATH)");
    expect(result.stdout).toContain(
      "credentials found  (instance role, detected region us-east-2)",
    );
    expect(result.stdout).toContain("1. Yes, use recommended defaults");
    expect(result.stdout).toContain("MCP servers on, all plugins, Bedrock via your AWS credentials");
    expect(result.stdout).toContain("Writing project files ... done");
    expect(result.stdout).toContain(
      "Recording your choices ... done  (aidlc.settings.json in this project)",
    );
    if (process.platform === "win32") {
      expect(result.stdout).toContain(
        `Add ${binRoot()} to your User PATH in Windows Settings, then open a new terminal.`,
      );
      expect(result.stdout).not.toContain('export PATH="$HOME/.local/bin:$PATH"');
    } else {
      expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
      expect(result.stdout).not.toContain("to your User PATH in Windows Settings");
    }
    expect(result.stdout).toContain(
      "Full diagnostics: bun .claude/tools/aidlc.ts config runtime --show",
    );
    expect(result.stdout).toContain('/aidlc "what you want built"');
    expect(existsSync(join(result.project, ".claude"))).toBe(true);
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.json"), "utf-8"),
    ).models.preset).toBe("balanced");
  }, 60_000);

  test("customize re-asks invalid preset and writes nothing when review declines", () => {
    const result = runWizard(
      "2\n\n\n\n\nthorogh\n2\n\n\n\nn\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Customize setup - 6 steps");
    expect(result.stdout).toContain("Kiro IDE        (not probed)");
    for (let step = 1; step <= 6; step++) {
      expect(result.stdout).toContain(`Step ${step} of 6`);
    }
    expect(result.stdout).toContain(
      "That's not one of the choices - enter 1, 2, or 3.",
    );
    expect(result.stdout).toContain("Using the thorough preset.");
    expect(result.stdout).toContain("Your choices - Enter to apply");
    expect(result.stdout).toContain("Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
  }, 60_000);

  test("review accepts a step number, re-enters it, then applies", () => {
    const result = runWizard(
      `${[
        "2",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "3",
        "3",
        "",
      ].join("\n")}\n`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.match(/Step 3 of 6 - Model effort preset/g)).toHaveLength(2);
    expect(result.stdout).toContain("Using the minimal preset.");
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.json"), "utf-8"),
    ).models.preset).toBe("minimal");
  }, 60_000);

  test("Ctrl-C sentinel exits before apply with Nothing written", () => {
    const result = runWizard("\u0003\n");
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  });

  test("multiple detected CLIs use the seam-driven numbered harness picker first", () => {
    const result = runWizard("2\n\n", {
      harnesses: {
        claude: { found: true, version: "claude 2.1.220" },
        codex: { found: true, version: "codex-cli 0.145.0" },
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.indexOf("Choose the harness for this project first."))
      .toBeLessThan(result.stdout.indexOf("AI-DLC setup - first run"));
    expect(result.stdout).toContain("Using Codex CLI.");
    expect(existsSync(join(result.project, ".codex"))).toBe(true);
  }, 60_000);

  test("OpenCode recommended Bedrock setup records an explicit default choice", () => {
    const result = runWizard("\n", {
      harnesses: {
        claude: { found: false },
        opencode: { found: true, version: "opencode 1.17.0" },
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const harness = JSON.parse(
      readFileSync(
        join(result.project, ".aidlc", "tools", "data", "harness.json"),
        "utf-8",
      ),
    );
    expect(harness.providers).toEqual(expect.objectContaining({
      provider: "amazon-bedrock",
      opencodeDefault: true,
    }));
  }, 60_000);

  test("late first-run failure restores every wizard-owned path", () => {
    const result = runWizard("\n", {
      env: { AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("No setup changes were kept.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
    expect(existsSync(join(result.project, ".git"))).toBe(true);
  }, 60_000);

  test("late first-run failure restores a pre-existing non-empty harness directory", () => {
    let before: Record<string, string> = {};
    const result = runWizard("\n", {
      env: { AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3" },
      prepare: (project) => {
        const harness = join(project, ".claude");
        mkdirSync(join(harness, "user", "nested"), { recursive: true });
        writeFileSync(join(harness, "user", "nested", "keep.txt"), "keep\n");
        writeFileSync(join(harness, "user-settings.json"), "{\"keep\":true}\n");
        before = treeSnapshot(harness);
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("No setup changes were kept.");
    expect(treeSnapshot(join(result.project, ".claude"))).toEqual(before);
  }, 60_000);

  test("late first-run rollback preserves a newer concurrent settings write", () => {
    const newer = `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    }, null, 2)}\n`;
    const priorGitignore = "# user-owned before setup\n";
    const result = runWizard("\n", {
      env: {
        AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3",
        AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE: newer,
      },
      prepare: (project) => {
        writeFileSync(join(project, ".gitignore"), priorGitignore);
      },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(result.project, "aidlc.settings.json"), "utf-8")).toBe(newer);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("rollback was incomplete");
    const recovery = /recovery snapshot preserved at ([^\r\n]+)/.exec(output)?.[1];
    expect(recovery).toBeDefined();
    expect(existsSync(recovery as string)).toBe(true);
    expect(
      readdirSync(recovery as string).some((entry) => {
        const path = join(recovery as string, entry);
        return statSync(path).isFile() &&
          readFileSync(path, "utf-8") === priorGitignore;
      }),
    ).toBe(true);
    temporary.push(recovery as string);
  }, 60_000);

  test("global first-run rollback uses the machine transaction boundary", () => {
    const machine = temp("aidlc-t299-global-machine-");
    const settings = join(machine, "aidlc.settings.json");
    mkdirSync(machine, { recursive: true });
    writeFileSync(settings, `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: false },
    }, null, 2)}\n`);
    const newer = `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    }, null, 2)}\n`;
    const input = `${[
      "2",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "3",
      "",
    ].join("\n")}\n`;
    const result = runWizard(input, {
      env: {
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
        AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3",
        AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE: newer,
        AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE_PATH: settings,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(readFileSync(settings, "utf-8")).toBe(newer);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("rollback was incomplete");
    const recovery = /recovery snapshot preserved at ([^\r\n]+)/.exec(output)?.[1];
    expect(recovery).toBeDefined();
    expect(existsSync(recovery as string)).toBe(true);
    temporary.push(recovery as string);
  }, 60_000);
});
