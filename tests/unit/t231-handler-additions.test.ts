// covers: subcommand:aidlc-utility:config-get, subcommand:aidlc-utility:config-list, subcommand:aidlc-utility:config-change
// covers: subcommand:aidlc-utility:plugin-list, subcommand:aidlc-utility:plugin-sync, subcommand:aidlc-utility:init, subcommand:aidlc-utility:upgrade
// covers: tool:aidlc, file:scripts/package.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const STATE_FIXTURE = join(FIXTURES_DIR, "state-mid-ideation.md");
const INIT_MESSAGE =
  "init now lays down the project data tree and is not yet available in this release. To start work, describe what to build: /aidlc \"build the auth service\".";
const UPGRADE_MESSAGE =
  "upgrade is not available in this install; it arrives with the packaged binary distribution.";
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
    expect(human.stdout).toBe("depth: Standard\ntest-strategy: Standard\n");

    const json = utility(["config-list", "--json"], project);
    expect(json.status).toBe(0);
    expect(parseJson<{ depth: string; "test-strategy": string }>(json.stdout)).toEqual({
      depth: "Standard",
      "test-strategy": "Standard",
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

  test("dispatcher config set translates to config-change and legacy spelling still works", () => {
    const project = stateProject();

    const setDepth = dispatcher(["config", "set", "depth", "comprehensive"], project);
    expect(setDepth.status).toBe(0);
    expect(stateField(project, "Depth")).toBe("Comprehensive");
    expect(utility(["config-get", "depth"], project).stdout).toBe("Comprehensive\n");

    const legacy = dispatcher(["config-change", "--depth", "minimal"], project);
    expect(legacy.status).toBe(0);
    expect(stateField(project, "Depth")).toBe("Minimal");
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

  test("plugin sync runs a discovered compose.ts with AIDLC_HARNESS_DIR", () => {
    const project = emptyProject();
    const pluginRoot = tempDir("aidlc-t231-plugin-");
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "hooks", "compose.ts"),
      [
        "import { writeFileSync } from \"node:fs\";",
        "import { join } from \"node:path\";",
        "const project = process.env.AIDLC_PROJECT_DIR || process.cwd();",
        "writeFileSync(join(project, \"plugin-sync-marker.txt\"), process.env.AIDLC_HARNESS_DIR || \"\");",
      ].join("\n"),
      "utf-8",
    );

    const result = utility(["plugin-sync"], project, { AIDLC_PLUGIN_ROOT: pluginRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("plugin sync complete: 1 plugin(s)\n");
    expect(readFileSync(join(project, "plugin-sync-marker.txt"), "utf-8")).toBe(".claude");
  });
});

describe("t231 init and upgrade transition handlers", () => {
  test("init errors loudly and does not create an intent record", () => {
    const project = emptyProject();
    const result = utility(["init"], project);

    expect(result.status).toBe(1);
    expect(stderrError(result)).toBe(INIT_MESSAGE);
    expect(existsSync(join(project, "aidlc", "spaces", "default", "intents"))).toBe(false);
  });

  test("dispatcher init shows the same transition error", () => {
    const project = emptyProject();
    const direct = utility(["init"], project);
    const routed = dispatcher(["init"], project);

    expect(routed.status).toBe(direct.status);
    expect(routed.stdout).toBe(direct.stdout);
    expect(routed.stderr).toBe(direct.stderr);
  });

  test("upgrade errors through utility, dispatcher, and slash alias", () => {
    const project = emptyProject();
    const direct = utility(["upgrade"], project);
    const routed = dispatcher(["upgrade"], project);
    const alias = dispatcher(["--upgrade"], project);

    for (const result of [direct, routed, alias]) {
      expect(result.status).toBe(1);
      expect(stderrError(result)).toBe(UPGRADE_MESSAGE);
    }
  });
});

describe("t231 emitted plugin hook command", () => {
  test("packaged hook probes aidlc first, bun second, and keeps graceful skip", () => {
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
    expect(command).toContain("\"$AIDLC\" plugin sync && exit 0");
    expect(command).not.toContain("plugin sync; exit $?");
    expect(command).toContain(`"$BUN" "\${CLAUDE_PLUGIN_ROOT}/hooks/compose.ts"`);
    expect(command).toContain("aidlc and bun not found, skipping");
  });
});
