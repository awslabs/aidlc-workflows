// Kiro IDE runs its agent's shell tool (still named execute_pwsh) in the
// person's default terminal profile. In Command Prompt, AI-DLC's commands,
// written for PowerShell, split the person's words at their single quotes and
// every command reports exit code -1 (measured live on Kiro IDE 1.2.37, #2167).
// The profile is `terminal.integrated.defaultProfile.windows` in Kiro's user
// settings, so it covers every project: AI-DLC sets PowerShell when the person
// says yes (setup, `config --yes`, a chat), keeps their answer once per machine,
// and never touches any other byte of their settings file.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import {
  kiroIdeTerminalAsk,
  readKiroIdeTerminal,
  readKiroTerminalAnswer,
  recordKiroTerminalAnswer,
  setKiroIdeTerminalPowerShell,
} from "../../core/tools/aidlc-kiro-ide-terminal.ts";
import {
  kiroIdeTerminalDoctorCheck,
  postApplyOutstandingActions,
  trustStatus,
} from "../../core/tools/aidlc-config-diagnostics.ts";

setDefaultTimeout(120_000);

const KEY = "terminal.integrated.defaultProfile.windows";
const ISSUE = "kiro-terminal-command-prompt";
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const HOST_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "KIRO_SESSION_ID", "OPENCODE",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "VSCODE_CODE_CACHE_PATH",
  "AIDLC_TEST_KIRO_IDE_SETTINGS", "AIDLC_TEST_KIRO_IDE_PLATFORM", "AIDLC_TEST_CONFIG_DETECTION_JSON",
];

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary.splice(0)) {
    if (path.includes("aidlc-test-")) cleanupTestProject(path);
    else rmSync(path, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

// A Windows machine of its own: AI-DLC's install root (the kept answer) and
// Kiro IDE's user settings file, both in a temporary folder.
function machine(settings?: string, platform = "win32"): { env: Record<string, string>; settingsPath: string; root: string } {
  const root = temp("aidlc-kiro-terminal-");
  const settingsPath = join(root, "Kiro", "User", "settings.json");
  if (settings !== undefined) {
    mkdirSync(join(root, "Kiro", "User"), { recursive: true });
    writeFileSync(settingsPath, settings);
  }
  return {
    root,
    settingsPath,
    env: {
      AIDLC_INSTALL_ROOT: join(root, "aidlc"),
      AIDLC_BIN_DIR: join(root, "aidlc", "bin"),
      AIDLC_TEST_KIRO_IDE_SETTINGS: settingsPath,
      AIDLC_TEST_KIRO_IDE_PLATFORM: platform,
    },
  };
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !HOST_ENV.includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

function runInit(args: string[], cwd: string, extra: Record<string, string>): { status: number; out: string } {
  const result = spawnSync(process.execPath, [INIT, ...args], { cwd, env: childEnv(extra), encoding: "utf-8" });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function installKiroIde(extra: Record<string, string>, yes = true): { project: string; out: string } {
  const project = temp("aidlc-t-kiro-terminal-project-");
  mkdirSync(join(project, ".git"));
  const result = runInit(
    ["config", "--project-dir", project, "--from", DIST_RELEASE, "--harness", "kiro-ide", ...(yes ? ["--yes"] : [])],
    project,
    extra,
  );
  expect(result.status, result.out).toBe(0);
  return { project, out: result.out };
}

const CMD_WITH_COMMENTS = `{
  // my editor
  "editor.fontSize": 14,
  "${KEY}": "Command Prompt", // picked with Terminal: Select Default Profile
  "kiroAgent.trust.defaultScope": "workspace",
}
`;
const POWERSHELL_SET = CMD_WITH_COMMENTS.replace(`"${KEY}": "Command Prompt"`, `"${KEY}": "PowerShell"`);

describe("reading Kiro IDE's terminal", () => {
  test("Command Prompt by its built-in name, or a profile of the person's own that runs cmd.exe", () => {
    expect(readKiroIdeTerminal(machine(CMD_WITH_COMMENTS).env)).toMatchObject({ commandPrompt: true, profile: "Command Prompt", readable: true });
    expect(readKiroIdeTerminal(machine(`{ "${KEY}": "command prompt" }`).env).commandPrompt).toBe(true);
    const custom = `{
  "terminal.integrated.profiles.windows": { "My cmd": { "path": "C:\\\\Windows\\\\System32\\\\cmd.exe", "args": ["/k"] } },
  "${KEY}": "My cmd"
}`;
    expect(readKiroIdeTerminal(machine(custom).env).commandPrompt).toBe(true);
    const listed = `{ "terminal.integrated.profiles.windows": { "c": { "path": ["\\"C:\\\\Windows\\\\cmd.exe\\""] } }, "${KEY}": "c" }`;
    expect(readKiroIdeTerminal(machine(listed).env).commandPrompt).toBe(true);
  });

  test("PowerShell, Git Bash, an absent key or file (Kiro's default, PowerShell) is not Command Prompt", () => {
    expect(readKiroIdeTerminal(machine().env)).toMatchObject({ commandPrompt: false, profile: null });
    expect(readKiroIdeTerminal(machine("{}\n").env).commandPrompt).toBe(false);
    expect(readKiroIdeTerminal(machine(`{ "${KEY}": "PowerShell" }`).env).commandPrompt).toBe(false);
    expect(readKiroIdeTerminal(machine(`{ "${KEY}": "Git Bash" }`).env).commandPrompt).toBe(false);
    expect(readKiroIdeTerminal(machine("{ not json").env)).toMatchObject({ commandPrompt: false, readable: false });
  });

  test("the setting is Kiro's on Windows only: elsewhere it is never Command Prompt", () => {
    expect(readKiroIdeTerminal(machine(CMD_WITH_COMMENTS, "darwin").env).commandPrompt).toBe(false);
    expect(readKiroIdeTerminal(machine(CMD_WITH_COMMENTS, "linux").env).commandPrompt).toBe(false);
  });
});

describe("setting PowerShell", () => {
  test("changes that one value and keeps every other byte", () => {
    const m = machine(CMD_WITH_COMMENTS);
    expect(setKiroIdeTerminalPowerShell(m.env)).toEqual({ settingsPath: m.settingsPath, changed: true });
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(POWERSHELL_SET);
    expect(setKiroIdeTerminalPowerShell(m.env).changed).toBe(false);
  });

  test("a missing file or key gets the one key; a file AI-DLC cannot edit is left alone with Kiro's own command named", () => {
    const absent = machine();
    setKiroIdeTerminalPowerShell(absent.env);
    expect(JSON.parse(readFileSync(absent.settingsPath, "utf-8"))).toEqual({ [KEY]: "PowerShell" });
    const broken = machine("{ not json");
    expect(() => setKiroIdeTerminalPowerShell(broken.env)).toThrow("run Terminal: Select Default Profile");
    expect(readFileSync(broken.settingsPath, "utf-8")).toBe("{ not json");
  });

  test("the person's answer is kept once per machine", () => {
    const m = machine();
    withEnv(m.env, () => {
      expect(readKiroTerminalAnswer()).toBeNull();
      recordKiroTerminalAnswer("kept");
      expect(readKiroTerminalAnswer()).toBe("kept");
      expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal"), "utf-8")).toBe("kept\n");
    });
  });
});

describe("the chat asks once", () => {
  const inKiro = (m: ReturnType<typeof machine>) => ({ ...m.env, VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") });

  test("a Kiro IDE chat in Command Prompt asks once; a no is simply not acting, and no chat asks again", () => {
    const m = machine(CMD_WITH_COMMENTS);
    withEnv(inKiro(m), () => {
      const line = kiroIdeTerminalAsk("bun .kiro/tools/aidlc.ts", process.env);
      expect(line).toContain("Kiro runs my commands in Command Prompt here, where AI-DLC's commands can split your words.");
      expect(line).toContain("Do you want me to set Kiro's terminal to PowerShell? It is a Kiro setting for all your projects.");
      expect(line).toContain("run `bun .kiro/tools/aidlc.ts config trust --kiro-terminal powershell --yes`");
      expect(readKiroTerminalAnswer()).toBe("asked");
      expect(kiroIdeTerminalAsk("bun .kiro/tools/aidlc.ts", process.env)).toBe("");
    });
  });

  test("no line in PowerShell, outside Kiro IDE, off Windows, or once the person answered at setup", () => {
    const ps = machine(`{ "${KEY}": "PowerShell" }`);
    withEnv(inKiro(ps), () => expect(kiroIdeTerminalAsk("aidlc", process.env)).toBe(""));
    const cli = machine(CMD_WITH_COMMENTS);
    withEnv(cli.env, () => expect(kiroIdeTerminalAsk("aidlc", process.env)).toBe(""));
    const mac = machine(CMD_WITH_COMMENTS, "darwin");
    withEnv(inKiro(mac), () => expect(kiroIdeTerminalAsk("aidlc", process.env)).toBe(""));
    const answered = machine(CMD_WITH_COMMENTS);
    withEnv(inKiro(answered), () => {
      recordKiroTerminalAnswer("kept");
      expect(kiroIdeTerminalAsk("aidlc", process.env)).toBe("");
    });
  });
});

describe("config trust and doctor", () => {
  test("trust names Command Prompt with the command that sets PowerShell, until the person answered", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    withEnv(m.env, () => {
      const issue = trustStatus(project, ".kiro", "kiro-ide").issues.find((entry) => entry.id === ISSUE);
      expect(issue?.message).toContain("Kiro runs its agent's commands in Command Prompt");
      const action = postApplyOutstandingActions(project, ".kiro", "kiro-ide").find((entry) => entry.id === ISSUE);
      expect(action?.command).toMatch(/config trust --kiro-terminal powershell$/);
      expect(trustStatus(project, ".kiro", "kiro").issues.some((entry) => entry.id === ISSUE)).toBe(false);
      recordKiroTerminalAnswer("kept");
      expect(trustStatus(project, ".kiro", "kiro-ide").issues.some((entry) => entry.id === ISSUE)).toBe(false);
    });
  });

  test("doctor warns in Command Prompt and names the same command and the restart; a row on Windows only", () => {
    const cmd = machine(CMD_WITH_COMMENTS);
    const { project } = installKiroIde({ ...cmd.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(cmd.root, "none.json") });
    const row = kiroIdeTerminalDoctorCheck(project, ".kiro", cmd.env);
    expect(row).toMatchObject({ pass: false, severity: "warn" });
    expect(row?.label).toContain("Kiro runs its agent's commands in Command Prompt");
    expect(row?.fix).toContain("config trust --kiro-terminal powershell");
    expect(row?.fix).toContain("restart Kiro");
    expect(kiroIdeTerminalDoctorCheck(project, ".kiro", machine(`{ "${KEY}": "PowerShell" }`).env))
      .toEqual({ pass: true, label: "Kiro terminal: PowerShell" });
    expect(kiroIdeTerminalDoctorCheck(project, ".kiro", machine().env))
      .toEqual({ pass: true, label: "Kiro terminal: PowerShell (Kiro's default)" });
    expect(kiroIdeTerminalDoctorCheck(project, ".kiro", machine(CMD_WITH_COMMENTS, "linux").env)).toBeNull();
  });

  test("`config --yes` sets PowerShell, says to restart Kiro, and keeps the answer; without --yes it only lists the step", () => {
    const yes = machine(CMD_WITH_COMMENTS);
    const first = installKiroIde(yes.env);
    expect(readFileSync(yes.settingsPath, "utf-8")).toBe(POWERSHELL_SET);
    expect(first.out).toContain("Set Kiro's terminal to PowerShell (a Kiro setting for all your projects). Restart Kiro so its chats use it.");
    withEnv(yes.env, () => expect(readKiroTerminalAnswer()).toBe("powershell"));

    const asked = machine(CMD_WITH_COMMENTS);
    const second = installKiroIde(asked.env, false);
    expect(readFileSync(asked.settingsPath, "utf-8")).toBe(CMD_WITH_COMMENTS);
    expect(second.out).toContain("config trust --kiro-terminal powershell");
    withEnv(asked.env, () => expect(readKiroTerminalAnswer()).toBeNull());

    const off = machine(CMD_WITH_COMMENTS, "darwin");
    installKiroIde(off.env);
    expect(readFileSync(off.settingsPath, "utf-8")).toBe(CMD_WITH_COMMENTS);
  });

  test("`config trust --kiro-terminal powershell` sets it; --show reads it; any other value is refused", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    const human = runInit(["config", "trust", "--project-dir", project, "--show"], project, m.env);
    expect(human.out).toContain(`Kiro terminal: Command Prompt (${m.settingsPath})`);
    const bad = runInit(["config", "trust", "--project-dir", project, "--kiro-terminal", "cmd", "--yes"], project, m.env);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("--kiro-terminal must be powershell");
    const set = runInit(["config", "trust", "--project-dir", project, "--kiro-terminal", "powershell", "--yes"], project, m.env);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain("Set Kiro's terminal to PowerShell");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(POWERSHELL_SET);
    withEnv(m.env, () => expect(readKiroTerminalAnswer()).toBe("powershell"));
  });

  test("the switch is Kiro IDE's: another harness's trust section refuses it", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const project = temp("aidlc-t-kiro-terminal-claude-");
    mkdirSync(join(project, ".git"));
    const install = runInit(
      ["config", "--project-dir", project, "--from", join(REPO_ROOT, "dist-release", "claude"), "--harness", "claude", "--yes"],
      project,
      m.env,
    );
    expect(install.status, install.out).toBe(0);
    const refused = runInit(["config", "trust", "--project-dir", project, "--kiro-terminal", "powershell", "--yes"], project, m.env);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--kiro-terminal applies to Kiro IDE projects");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(CMD_WITH_COMMENTS);
  });
});

describe("what the agent reads", () => {
  test("Command Prompt's constant exit code -1 is not read as an untrusted folder", () => {
    const skill = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain(
      "**When a command comes back with no output and exit code -1**, Kiro has not been allowed to run commands in this " +
        "folder yet. (When Kiro says your shell is cmd, every command reports exit code -1, so there go by what it printed.)",
    );
  });

  test("both Kiro agent prompts say never to send an AI-DLC command's reply to a file", () => {
    const ide = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents", "aidlc.md"), "utf-8");
    const cli = (JSON.parse(readFileSync(join(REPO_ROOT, "dist", "kiro", ".kiro", "agents", "aidlc.json"), "utf-8")) as { prompt: string }).prompt;
    for (const prompt of [ide, cli]) {
      expect(prompt).toContain("(5) run AI-DLC's commands as written and read their reply from the command's result: never send it to a file.");
    }
  });
});
