// covers: tool:aidlc-init, function:readTerminalLine

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { readTerminalLine } from "../../core/tools/aidlc-command.ts";
import {
  firstRunFailureLines,
  launchedFromEditorTerminal,
} from "../../core/tools/aidlc-init.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const RUNTIME = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];
// Complete overrides keep PTY tests independent of shell startup PATH additions.
const HARNESS_NAMES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;

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
      HARNESS_NAMES.map((name) => {
        const value = harnesses[name] ?? {
          found: false,
          probed: name !== "kiro-ide",
        };
        return [
          name,
          {
            ...value,
            ...(value.found ? { path: join(bin, name === "kiro" ? "kiro-cli" : name) } : {}),
          },
        ];
      }),
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

// The editor-terminal markers launchedFromEditorTerminal reads. The runner's
// own terminal must not decide which harness a case selects.
const EDITOR_TERMINAL_ENV = [
  "TERM_PROGRAM",
  "VSCODE_GIT_ASKPASS_NODE",
] as const;

function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of EDITOR_TERMINAL_ENV) delete env[name];
  return env;
}

// Children never see the host's real machine install: a developer with
// `aidlc` installed would otherwise get every harness listed twice (the
// explicit AIDLC_RUNTIME_ROOT plus the active machine runtime).
function isolatedMachineEnv(): NodeJS.ProcessEnv {
  const machine = temp("aidlc-t299-machine-");
  return {
    AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
    AIDLC_BIN_DIR: join(machine, "bin"),
  };
}

function runWizard(
  input: string,
  options: {
    harnesses?: Record<string, { found: boolean; version?: string }>;
    aidlc?: boolean;
    runtimeIssue?: boolean;
    env?: NodeJS.ProcessEnv;
    prepare?: (project: string) => void;
    // Real git after the stubs, for checks that ask git about the project.
    gitOnPath?: boolean;
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
        ...hostEnv(),
        ...isolatedMachineEnv(),
        PATH: options.gitOnPath ? `${bin}${delimiter}${dirname(Bun.which("git") ?? "git")}` : bin,
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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return {
    project,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function wizardStderrMessage(stderr: string): string {
  try {
    const parsed = JSON.parse(stderr) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : stderr;
  } catch {
    return stderr;
  }
}

describe("t299 first-run setup wizard", () => {
  test("recommended defaults render detection, trichotomy, receipts, blocker, and next commands", () => {
    const machineEnv = isolatedMachineEnv();
    const result = runWizard("\n", {
      aidlc: false,
      runtimeIssue: true,
      env: machineEnv,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("AI-DLC setup - first run in this project.");
    expect(result.stdout).toContain("Claude Code detected  (2.1.220 on your PATH)");
    expect(result.stdout).toContain(
      "credentials found  (instance role, detected region us-east-2)",
    );
    expect(result.stdout).toContain("1. Yes, use recommended defaults");
    expect(result.stdout).toContain(
      "MCP servers on, all plugins, current model provider preserved",
    );
    expect(result.stdout).toContain("medium project agent effort for deciding");
    expect(result.stdout).not.toContain("effort dials do not apply");
    expect(result.stdout).toContain("Writing project files ... done");
    expect(result.stdout).toContain(
      "Recording model preset ... done  (aidlc.settings.json in this project)",
    );
    if (process.platform === "win32") {
      expect(result.stdout).toContain(
        `Add ${machineEnv.AIDLC_BIN_DIR} to your User PATH in Windows Settings, then open a new terminal.`,
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("recommended defaults name a .gitignore rule that hides committed records", () => {
    const result = runWizard("\n", {
      gitOnPath: true,
      prepare: (project) => {
        rmSync(join(project, ".git"), { recursive: true, force: true });
        expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
        writeFileSync(join(project, ".gitignore"), "aidlc/\n");
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const note = result.stdout.indexOf("Note: .gitignore:1 hides committed workflow records");
    expect(note, result.stdout).toBeGreaterThan(-1);
    expect(note).toBeLessThan(result.stdout.indexOf("Setup complete."));
    expect(readFileSync(join(result.project, ".gitignore"), "utf-8").startsWith("aidlc/\n")).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("recommended defaults explain unsupported group effort on Kiro CLI", () => {
    const result = runWizard("\n", {
      harnesses: { kiro: { found: true, version: "kiro-cli 1.0.0" } },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("In Kiro CLI, effort dials do not apply");
    expect(result.stdout).not.toContain("medium project agent effort for deciding");
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.json"), "utf-8"),
    ).models.preset).toBe("balanced");
    expect(existsSync(join(result.project, ".kiro"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("customize re-asks invalid preset and writes nothing when review declines", () => {
    const result = runWizard(
      "2\n\n\nthorogh\n2\n\n\n\nn\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Customize setup - 6 steps");
    expect(result.stdout).toContain("Kiro IDE        (not probed)");
    for (let step = 1; step <= 6; step++) {
      expect(result.stdout).toContain(`Step ${step} of 6`);
    }
    expect(result.stdout).toContain(
      "That's not one of the choices - enter 1, 2, ... or 4.",
    );
    expect(result.stdout).toContain("Using the thorough preset.");
    expect(result.stdout).toContain("Your choices - Enter to apply");
    expect(result.stdout).toContain("Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("unchanged completes setup without recording model policy in any settings layer", () => {
    const env = isolatedMachineEnv();
    const result = runWizard("2\n\n\n4\n\n\n\n\n", { env });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Keeping existing settings unchanged; no preset recorded.");
    expect(result.stdout).toContain("3. Preset       none (unchanged)");
    expect(result.stdout).toContain("6. Preset in    n/a (no preset recorded)");
    expect(result.stdout).not.toContain("Preset in [");
    expect(result.stdout).not.toContain("Using the unchanged preset.");
    expect(result.stdout).not.toContain("Recording model preset");
    expect(result.stdout).toContain("Model preset ... left unchanged");
    expect(result.stdout).toContain("Setup complete.");
    expect(existsSync(join(result.project, ".claude", "settings.json"))).toBe(true);
    for (const path of [
      join(result.project, "aidlc.settings.json"),
      join(result.project, "aidlc.settings.local.json"),
      join(env.AIDLC_INSTALL_ROOT as string, "aidlc.settings.json"),
    ]) {
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
      expect(settings).not.toHaveProperty("models");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("unchanged preserves pre-seeded project policy byte-for-byte", () => {
    const prior = `${JSON.stringify({
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        preset: "thorough",
        groups: { reviewing: { effort: "xhigh" } },
        agents: { architect: { model: { claude: "vendor/custom-model" }, effort: "high" } },
      },
    }, null, 4)}\n`;
    const env = isolatedMachineEnv();
    const result = runWizard("2\n\n\n4\n\n\n\n\n", {
      env,
      prepare: (project) => {
        writeFileSync(join(project, "aidlc.settings.json"), prior);
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Setup complete.");
    expect(readFileSync(join(result.project, "aidlc.settings.json"), "utf-8")).toBe(prior);
    for (const path of [
      join(result.project, "aidlc.settings.local.json"),
      join(env.AIDLC_INSTALL_ROOT as string, "aidlc.settings.json"),
    ]) {
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
      expect(settings).not.toHaveProperty("models");
    }
    expect(readFileSync(
      join(result.project, ".claude", "agents", "aidlc-product-lead-agent.md"),
      "utf-8",
    )).toContain("effort: xhigh");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("changing an unchanged preset re-opens the preset target step", () => {
    const result = runWizard(
      `${["2", "", "", "4", "", "", "3", "1", "2", ""].join("\n")}\n`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.match(/Step 6 of 6 - Where to record the model preset/g))
      .toHaveLength(2);
    expect(result.stdout.match(/Preset in \[1\]:/g)).toHaveLength(1);
    expect(result.stdout).toContain("6. Preset in    this project, just for you");
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.local.json"), "utf-8"),
    ).models.preset).toBe("balanced");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Kiro IDE's terminal selects Kiro IDE and ends with trust, reload, and agent steps", () => {
    const result = runWizard("\n", {
      harnesses: { claude: { found: false } },
      env: { TERM_PROGRAM: "kiro" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Choose the harness for this project first.");
    expect(result.stdout).toContain("Kiro IDE detected  (running in Kiro IDE's terminal)");
    expect(result.stdout).toContain([
      "  Setup complete. Start your first workflow:",
      "",
      "    1. Open this folder in Kiro IDE. If the Restricted Mode banner shows at the",
      "       top of the window, select Manage on it, then Trust.",
      '    2. Run "Developer: Reload Window" from the Command Palette',
      "       (Ctrl+Shift+P, or Cmd+Shift+P on macOS) so Kiro loads the AIDLC hooks",
      "       and the aidlc agent.",
      "    3. Choose the aidlc agent in the chat panel's agent picker.",
      '    4. /aidlc "what you want built"  describe your first intent',
      "",
      "    Using Kiro CLI instead? Start `kiro-cli` in this folder, then step 4.",
      "",
    ].join("\n"));
    expect(existsSync(join(result.project, ".kiro"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Kiro IDE's terminal makes Kiro IDE the picker default when another CLI is found", () => {
    const result = runWizard("\n\n", {
      env: { TERM_PROGRAM: "kiro" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Choose the harness for this project first.");
    expect(result.stdout).toContain("Using Kiro IDE.");
    expect(existsSync(join(result.project, ".kiro"))).toBe(true);
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Harness detection must not change the default outside Kiro IDE: a plain
  // terminal, VS Code, Cursor, and iTerm keep the first detected CLI.
  for (
    const [terminal, env] of [
      ["a plain terminal", {}],
      [
        "VS Code's terminal",
        {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        },
      ],
      [
        "Cursor's terminal",
        {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
        },
      ],
      ["iTerm", { TERM_PROGRAM: "iTerm.app", __CFBundleIdentifier: "com.googlecode.iterm2" }],
    ] as const
  ) {
    test(`${terminal} keeps the first detected CLI as the picker default`, () => {
      const result = runWizard("\n\n", {
        harnesses: {
          claude: { found: true, version: "claude 2.1.220" },
          codex: { found: true, version: "codex-cli 0.145.0" },
        },
        env,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Using Claude Code.");
      expect(result.stdout).not.toContain("Kiro IDE detected");
      expect(existsSync(join(result.project, ".claude"))).toBe(true);
      expect(existsSync(join(result.project, ".kiro"))).toBe(false);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // Kiro IDE's first-run steps live in its own manifest; every other harness
  // keeps the open-then-/aidlc pair.
  for (
    const [harness, open] of [
      ["claude", "claude                         open Claude Code in this repo"],
      ["codex", "codex                         open Codex CLI in this repo"],
      ["copilot", "copilot                        open Copilot CLI in this repo"],
      ["cursor", "cursor                         open Cursor in this repo"],
      ["kiro", "kiro-cli chat                  open Kiro CLI in this repo"],
      ["opencode", "opencode                       open opencode in this repo"],
    ] as const
  ) {
    test(`${harness} setup ends with its own next steps and no Kiro IDE advice`, () => {
      const result = runWizard("\n", {
        harnesses: {
          claude: { found: harness === "claude" },
          [harness]: { found: true },
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const invoke = harness === "codex" ? "$aidlc" : "/aidlc";
      expect(result.stdout).toContain(
        "  Setup complete. Start your first workflow:\n\n" +
          `    ${open}\n` +
          `    ${invoke} "what you want built"  describe your first intent\n`,
      );
      for (const kiroIdeWord of ["Reload Window", "Restricted Mode", "agent picker", "Kiro IDE"]) {
        expect(result.stdout).not.toContain(kiroIdeWord);
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("OpenCode recommended setup preserves the current provider", () => {
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
      provider: "current",
    }));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("late first-run failure restores every wizard-owned path", () => {
    const result = runWizard("\n", {
      env: { AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "  Setup stopped: injected first-run failure after child 3.\n  No setup changes were kept.",
    );
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
    expect(existsSync(join(result.project, ".git"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    const output = `${result.stdout}${wizardStderrMessage(result.stderr)}`;
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    const output = `${result.stdout}${wizardStderrMessage(result.stderr)}`;
    expect(output).toContain("rollback was incomplete");
    const recovery = /recovery snapshot preserved at ([^\r\n]+)/.exec(output)?.[1];
    expect(recovery).toBeDefined();
    expect(existsSync(recovery as string)).toBe(true);
    temporary.push(recovery as string);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Bun's global prompt() returns null for an empty line, which the wizard read
  // as "cancelled". Every bracketed default in the wizard depends on Enter
  // yielding "" and only a closed stdin yielding null.
  test("terminal reader distinguishes Enter (default) from a closed stdin (cancel)", () => {
    const dir = temp("aidlc-t299-reader-");
    const read = (content: string): string | null => {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.txt`);
      writeFileSync(path, content);
      const fd = openSync(path, "r");
      try {
        return readTerminalLine("Q:", fd);
      } finally {
        closeSync(fd);
      }
    };
    expect(read("\n")).toBe("");
    expect(read("\r\n")).toBe("");
    expect(read("2\n")).toBe("2");
    expect(read("partial")).toBe("partial");
    expect(read("")).toBeNull();
    // Consecutive answers on one descriptor: nothing past the newline is consumed.
    const path = join(dir, "queued.txt");
    writeFileSync(path, "us-east-1\r\n\nminimal\n");
    const fd = openSync(path, "r");
    try {
      expect(readTerminalLine("Q:", fd)).toBe("us-east-1");
      expect(readTerminalLine("Q:", fd)).toBe("");
      expect(readTerminalLine("Q:", fd)).toBe("minimal");
      expect(readTerminalLine("Q:", fd)).toBeNull();
    } finally {
      closeSync(fd);
    }
  });

  // The scripted-answer seam above never reaches the real terminal path, so this
  // drives the wizard through a real pty (util-linux `script`) with a bare Enter
  // at the recommended-defaults gate and expects files to be written.
  const script = process.platform === "linux" ? Bun.which("script") : null;
  test.skipIf(!script)("bare Enter on a real terminal accepts the recommended defaults", () => {
    const project = temp("aidlc-t299-pty-project-");
    const bin = temp("aidlc-t299-pty-bin-");
    mkdirSync(join(project, ".git"));
    executable(join(bin, "claude"), "claude 2.1.220");
    executable(join(bin, "getconf"), bin);
    const result = spawnSync(
      script as string,
      ["-qfec", `${BUN} ${INIT} config --project-dir ${project}`, "/dev/null"],
      {
        cwd: project,
        env: {
          ...hostEnv(),
          ...isolatedMachineEnv(),
          PATH: bin,
          NO_COLOR: "1",
          AIDLC_RUNTIME_ROOT: RUNTIME,
          AIDLC_TEST_CONFIG_DETECTION_JSON: detection(bin),
        },
        input: "\n",
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      },
    );
    const output = `${result.stdout}${wizardStderrMessage(result.stderr)}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Choice [1]:");
    expect(output).not.toContain("Nothing written.");
    expect(output).toContain("Writing project files ... done");
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t299 first-run guidance helpers", () => {
  test("only Kiro IDE ships first-run steps, an editor name, and hook-activation advice", () => {
    for (const harness of HARNESS_NAMES) {
      const root = join(RUNTIME, harness);
      const harnessDir = readdirSync(root).find((entry) =>
        existsSync(join(root, entry, "tools", "data", "aidlc-projection.json"))
      );
      expect(harnessDir, harness).toBeDefined();
      const data = join(root, harnessDir ?? "", "tools", "data");
      const projection = JSON.parse(readFileSync(join(data, "aidlc-projection.json"), "utf-8"));
      const shipped = JSON.parse(readFileSync(join(data, "harness.json"), "utf-8"));
      const kiroIde = harness === "kiro-ide";
      expect(Object.hasOwn(projection, "firstRunSteps"), harness).toBe(kiroIde);
      expect(Object.hasOwn(projection, "editorTerminalApp"), harness).toBe(kiroIde);
      expect(Object.hasOwn(shipped, "hookActivation"), harness).toBe(kiroIde);
    }
  });

  test("an editor's terminal is recognized from its editor markers, not KIRO_* variables", () => {
    // Kiro IDE's terminal sets TERM_PROGRAM=kiro; its askpass helper is Kiro.exe.
    for (const env of [
      { TERM_PROGRAM: "kiro" },
      { TERM_PROGRAM: "Kiro" },
      { VSCODE_GIT_ASKPASS_NODE: "D:\\Apps\\Kiro\\Kiro.exe" },
    ]) {
      expect(launchedFromEditorTerminal("kiro", env), JSON.stringify(env)).toBe(true);
    }
    for (const env of [
      {},
      {
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      },
      {
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "D:\\Apps\\cursor\\Cursor.exe",
      },
      { TERM_PROGRAM: "iTerm.app" },
      { TERM_PROGRAM: "kirobuild" },
      { KIRO_API_KEY: "set" },
      { VSCODE_GIT_ASKPASS_NODE: "D:\\Apps\\Kiro\\Code.exe" },
      { VSCODE_GIT_ASKPASS_MAIN: "D:\\Apps\\Kiro\\resources\\app\\extensions\\git\\dist\\askpass-main.js" },
    ]) {
      expect(launchedFromEditorTerminal("kiro", env), JSON.stringify(env)).toBe(false);
    }
    // The name is the harness's own: another editor matches only itself.
    expect(launchedFromEditorTerminal("cursor", { TERM_PROGRAM: "kiro" })).toBe(false);
  });

  test("a failed setup step reads as a sentence with the fix as a command", () => {
    const rerun = "aidlc config";
    expect(firstRunFailureLines(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      code: "transaction-failed",
      status: 1,
      message: "aidlc.settings.json: transaction source changed while staging",
      remediation: "aidlc config --from <valid-release-data>",
    }), rerun)).toEqual([
      "Setup stopped: another AIDLC process was writing at the same time.",
      "fix: run `aidlc config` again",
    ]);
    expect(firstRunFailureLines(JSON.stringify({
      message: "the release data could not be read",
      remediation: "aidlc config --from <valid-release-data>",
    }), rerun)).toEqual([
      "Setup stopped: the release data could not be read.",
      "fix: run `aidlc config` again",
    ]);
    expect(firstRunFailureLines(JSON.stringify({
      message: "the project is not writable.",
      remediation: "make the project folder writable",
    }), rerun)).toEqual([
      "Setup stopped: the project is not writable.",
      "fix: make the project folder writable",
    ]);
    expect(firstRunFailureLines('{"error":"no release data for kiro-ide"}\n', rerun)).toEqual([
      "Setup stopped: no release data for kiro-ide.",
    ]);
    expect(firstRunFailureLines("plain failure", rerun)).toEqual([
      "Setup stopped: plain failure.",
    ]);
  });
});
