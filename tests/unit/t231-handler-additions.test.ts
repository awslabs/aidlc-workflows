// covers: subcommand:aidlc-utility:config-get, subcommand:aidlc-utility:config-list, subcommand:aidlc-utility:config-change
// covers: subcommand:aidlc-utility:plugin-list, subcommand:aidlc-utility:plugin-sync, subcommand:aidlc-utility:upgrade
// covers: tool:aidlc, file:scripts/package.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const CORE_TOOLS_DIR = join(REPO_ROOT, "core", "tools");
const UTILITY = join(CORE_TOOLS_DIR, "aidlc-utility.ts");
const DISPATCHER = join(CORE_TOOLS_DIR, "aidlc.ts");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const POSIX_SH = process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe")
  : "/bin/sh";
const PLUGIN_COMPOSE_TEMPLATE = join(
  REPO_ROOT,
  "scripts",
  "plugin-hooks-template",
  "compose.ts",
);
const STATE_FIXTURE = join(FIXTURES_DIR, "state-mid-ideation.md");
const NO_STATE_MESSAGE =
  "No state file found. Start a workflow first by describing what to build (/aidlc \"build the auth service\").";

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  out: string;
};

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stateProject(): string {
  const project = createTestProject();
  tempDirs.push(project);
  seedStateFile(project, STATE_FIXTURE);
  return project;
}

function emptyProject(): string {
  return tempDir("aidlc-t231-empty-");
}

function run(cmd: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_PROJECT_DIR: cwd,
    },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? -1, stdout, stderr, out: stdout + stderr };
}

function utility(args: string[], project: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  return run([BUN, UTILITY, ...args, "--project-dir", project], project, extraEnv);
}

function dispatcher(args: string[], project: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  return run(
    [BUN, DISPATCHER, ...args, "--project-dir", project],
    project,
    { AIDLC_DISPATCH_TOOLS_DIR: CORE_TOOLS_DIR, ...extraEnv },
  );
}

function stateField(project: string, field: string): string {
  const content = readFileSync(seededStateFile(project), "utf-8");
  const m = content.match(new RegExp(`^- \\*\\*${field}\\*\\*:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

function copiedToolsTree(harnessJson: Record<string, unknown>): string {
  const root = tempDir("aidlc-t231-tools-");
  const toolsDir = join(root, ".claude", "tools");
  cpSync(CORE_TOOLS_DIR, toolsDir, { recursive: true });
  mkdirSync(join(toolsDir, "data"), { recursive: true });
  writeFileSync(join(toolsDir, "data", "harness.json"), `${JSON.stringify(harnessJson, null, 2)}\n`, "utf-8");
  writeFileSync(
    join(toolsDir, "data", "stage-graph.json"),
    `${JSON.stringify(
      [
        { slug: "workspace-scaffold", phase: "initialization" },
        { slug: "code-generation", phase: "construction" },
        { slug: "test-pro-integration", phase: "construction", plugin: "test-pro" },
      ],
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return toolsDir;
}

function runCopiedUtility(toolsDir: string, args: string[], project: string): RunResult {
  return run(
    [BUN, join(toolsDir, "aidlc-utility.ts"), ...args, "--project-dir", project],
    project,
    { AIDLC_HARNESS_DIR: ".claude" },
  );
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function stderrError(result: RunResult): string {
  try {
    const parsed = JSON.parse(result.stderr) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : result.stderr;
  } catch {
    return result.stderr;
  }
}

describe("t231 config get/list/set handlers", () => {
  test("config get prints depth and test-strategy from the active state", () => {
    const project = stateProject();

    expect(utility(["config-get", "depth"], project).stdout).toBe("Standard\n");
    expect(utility(["config-get", "test-strategy"], project).stdout).toBe("Standard\n");
  });

  test("config list prints human and json forms", () => {
    const project = stateProject();

    const human = utility(["config-list"], project);
    expect(human.status).toBe(0);
    // review is empty on a fixture with no per-run override set (2.5.40).
    expect(human.stdout).toBe("depth: Standard\ntest-strategy: Standard\nreview: \n");

    const json = utility(["config-list", "--json"], project);
    expect(json.status).toBe(0);
    expect(
      parseJson<{ depth: string; "test-strategy": string; review: string }>(json.stdout)
    ).toEqual({
      depth: "Standard",
      "test-strategy": "Standard",
      review: "",
    });
  });

  test("config get rejects unknown keys and missing workflows", () => {
    const project = stateProject();
    const unknown = utility(["config-get", "scope"], project);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Valid keys: depth, test-strategy");

    const empty = emptyProject();
    const missing = utility(["config-get", "depth"], empty);
    expect(missing.status).toBe(1);
    expect(stderrError(missing)).toBe(NO_STATE_MESSAGE);
  });

  test("engine config set translates to config-change and legacy top-level spelling is rejected", () => {
    const project = stateProject();

    const setDepth = dispatcher(
      ["engine", "config", "set", "depth", "comprehensive"],
      project,
    );
    expect(setDepth.status).toBe(0);
    expect(stateField(project, "Depth")).toBe("Comprehensive");
    expect(utility(["config-get", "depth"], project).stdout).toBe("Comprehensive\n");

    const legacy = dispatcher(["config-change", "--depth", "minimal"], project);
    expect(legacy.status).toBe(2);
    expect(stateField(project, "Depth")).toBe("Comprehensive");
  });
});

describe("t231 plugin list and sync handlers", () => {
  test("plugin list reports all enabled when harness selection is absent", () => {
    const project = emptyProject();
    const toolsDir = copiedToolsTree({ harnessDir: ".claude", rulesSubdir: "rules" });
    const result = runCopiedUtility(toolsDir, ["plugin-list", "--json"], project);

    expect(result.status).toBe(0);
    expect(
      parseJson<{ plugins: Array<{ name: string; enabled: boolean }>; selectionActive: boolean }>(result.stdout),
    ).toEqual({
      plugins: [
        { name: "aidlc", enabled: true },
        { name: "test-pro", enabled: true },
      ],
      selectionActive: false,
    });
  });

  test("plugin list reports disabled plugins when harness selection is active", () => {
    const project = emptyProject();
    const toolsDir = copiedToolsTree({ harnessDir: ".claude", rulesSubdir: "rules", plugins: ["test-pro"] });
    const result = runCopiedUtility(toolsDir, ["plugin-list"], project);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Plugin selection: test-pro");
    expect(result.stdout).toContain("aidlc disabled");
    expect(result.stdout).toContain("test-pro enabled");
  });

  test("plugin sync is idempotent with no plugin roots", () => {
    const project = emptyProject();
    const result = utility(["plugin-sync"], project, {
      AIDLC_PLUGIN_ROOT: "",
      CLAUDE_PLUGIN_ROOT: "",
      PLUGIN_ROOT: "",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("no installed plugins; nothing to sync\n");
  });

  test("plugin sync fails when a configured root has no compose hook", () => {
    const project = emptyProject();
    const pluginRoot = tempDir("aidlc-t231-plugin-no-compose-");
    const result = utility(["plugin-sync"], project, {
      AIDLC_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_ROOT: "",
      PLUGIN_ROOT: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(pluginRoot);
    expect(result.stderr).toContain("missing hooks/compose.ts");
  });

  test("plugin sync names and classifies every unusable configured root", () => {
    const project = emptyProject();
    const composeLessRoot = tempDir("aidlc-t231-plugin-no-compose-");
    const missingRoot = join(tempDir("aidlc-t231-plugin-missing-parent-"), "not-installed");
    const result = utility(["plugin-sync"], project, {
      AIDLC_PLUGIN_ROOT: composeLessRoot,
      CLAUDE_PLUGIN_ROOT: missingRoot,
      PLUGIN_ROOT: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`- ${composeLessRoot}: missing hooks/compose.ts`);
    expect(result.stderr).toContain(`- ${missingRoot}: root directory does not exist`);
  });

  test("plugin sync warns about compose-less roots while composing valid roots", () => {
    const project = emptyProject();
    const pluginRoot = tempDir("aidlc-t231-plugin-valid-");
    const skippedRoot = tempDir("aidlc-t231-plugin-no-compose-");
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "hooks", "compose.ts"),
      [
        "import { writeFileSync } from \"node:fs\";",
        "import { join } from \"node:path\";",
        "const project = process.env.AIDLC_PROJECT_DIR || process.cwd();",
        "writeFileSync(join(project, \"plugin-sync-mixed-marker.txt\"), \"composed\");",
      ].join("\n"),
      "utf-8",
    );

    const result = utility(["plugin-sync"], project, {
      AIDLC_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_ROOT: skippedRoot,
      PLUGIN_ROOT: "",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("plugin sync complete: 1 plugin(s)\n");
    expect(result.stderr).toContain(skippedRoot);
    expect(result.stderr).toContain("missing hooks/compose.ts");
    expect(readFileSync(join(project, "plugin-sync-mixed-marker.txt"), "utf-8")).toBe("composed");
  });

  test("plugin sync runs a discovered compose.ts with harness dir and name", () => {
    const project = emptyProject();
    const pluginRoot = tempDir("aidlc-t231-plugin-");
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "hooks", "compose.ts"),
      [
        "import { writeFileSync } from \"node:fs\";",
        "import { join } from \"node:path\";",
        "const project = process.env.AIDLC_PROJECT_DIR || process.cwd();",
        "writeFileSync(join(project, \"plugin-sync-marker.txt\"), (process.env.AIDLC_HARNESS_DIR || \"\") + \"|\" + (process.env.AIDLC_HARNESS_NAME || \"\"));",
      ].join("\n"),
      "utf-8",
    );

    const result = utility(["plugin-sync"], project, { AIDLC_PLUGIN_ROOT: pluginRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("plugin sync complete: 1 plugin(s)\n");
    expect(readFileSync(join(project, "plugin-sync-marker.txt"), "utf-8")).toBe(".claude|claude");
  });
});

describe("t231 config and update lifecycle routing", () => {
  test("config reaches the dedicated delegate and does not create an intent record on source failure", () => {
    const project = emptyProject();
    const result = run(
      [BUN, join(CORE_TOOLS_DIR, "aidlc-init.ts"), "config", "--project-dir", project],
      project,
    );

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("no installed harness runtime");
    expect(existsSync(join(project, "aidlc", "spaces", "default", "intents"))).toBe(false);
  });

  test("dispatcher config matches its dedicated delegate", () => {
    const project = emptyProject();
    const direct = run(
      [BUN, join(CORE_TOOLS_DIR, "aidlc-init.ts"), "config", "--project-dir", project],
      project,
    );
    const routed = dispatcher(["config"], project);

    expect(routed.status).toBe(direct.status);
    expect(routed.stdout).toBe(direct.stdout);
    expect(routed.stderr).toBe(direct.stderr);
  });

  test("update reaches the lifecycle delegate and upgrade spellings are rejected", () => {
    const project = emptyProject();
    const machine = tempDir("aidlc-t231-update-machine-");
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_OFFLINE: "1",
    };
    const direct = run(
      [BUN, join(CORE_TOOLS_DIR, "aidlc-lifecycle.ts"), "update"],
      project,
      env,
    );
    const routed = dispatcher(["update"], project, env);
    const alias = dispatcher(["--upgrade"], project);

    expect(routed.status).toBe(direct.status);
    expect(routed.stdout).toBe(direct.stdout);
    expect(routed.stderr).toBe(direct.stderr);
    expect(routed.status).toBe(3);
    expect(dispatcher(["upgrade"], project).status).toBe(2);
    expect(alias.status).toBe(2);
  });

  test("legacy direct utility upgrade remains an explicit unavailable error", () => {
    const project = emptyProject();
    const result = utility(["upgrade"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("upgrade is not available in this install");
  });
});

describe("t231 emitted plugin hook command", () => {
  test("compiled runner-gen calls map only to the gen noun", () => {
    const template = readFileSync(PLUGIN_COMPOSE_TEMPLATE, "utf-8");
    expect(template).toContain(
      'if (args[0] === "write") return [executable, "engine", "gen", "runners"',
    );
    expect(template).toContain(
      'if (args[0] === "check") return [executable, "engine", "gen", "runners", "--check"',
    );
    expect(template).toContain(
      'if (args[0] === "scopes") return [executable, "engine", "gen", "runner-scopes"',
    );
    expect(template).toContain(
      'if (args[0] === "list") return [executable, "engine", "gen", "runner-list"',
    );
    expect(template).not.toContain('"engine", "runner-gen"');
  });

  test("packaged hook probes aidlc first, propagates sync failures, and keeps graceful skip", () => {
    const outDir = join(tempDir("aidlc-t231-package-"), "plugin");
    const build = run([BUN, PACKAGE_TS, "plugin", "build", "test-pro", "claude", outDir], REPO_ROOT);
    expect(build.status).toBe(0);

    const hooks = parseJson<{
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    }>(readFileSync(join(outDir, "hooks", "hooks.json"), "utf-8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    const aidlcIdx = command.indexOf("command -v aidlc");
    const bunIdx = command.indexOf("command -v bun");

    expect(aidlcIdx).toBeGreaterThanOrEqual(0);
    expect(bunIdx).toBeGreaterThan(aidlcIdx);
    expect(command).toContain("\"$AIDLC\" engine plugin sync; exit $?");
    expect(command).toContain("AIDLC_HARNESS_NAME=claude");
    expect(command).toContain(`"$BUN" "\${CLAUDE_PLUGIN_ROOT}/hooks/compose.ts"`);
    expect(command).toContain("aidlc and bun not found, skipping");

    const binDir = tempDir("aidlc-t231-hook-bin-");
    const fallbackMarker = join(binDir, "fallback-ran");
    writeFileSync(join(binDir, "aidlc"), "#!/bin/sh\nexit 23\n");
    writeFileSync(join(binDir, "bun"), `#!/bin/sh\ntouch "${fallbackMarker}"\nexit 0\n`);
    chmodSync(join(binDir, "aidlc"), 0o755);
    chmodSync(join(binDir, "bun"), 0o755);
    const invoked = spawnSync(POSIX_SH, ["-c", command], {
      cwd: outDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: [binDir, dirname(POSIX_SH), process.env.PATH ?? ""].join(delimiter),
        CLAUDE_PLUGIN_ROOT: outDir,
        CLAUDE_PROJECT_DIR: outDir,
      },
    });
    expect(invoked.status).toBe(23);
    expect(existsSync(fallbackMarker)).toBe(false);
  });
});
