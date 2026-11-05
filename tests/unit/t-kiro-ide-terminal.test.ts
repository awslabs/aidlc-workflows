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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import {
  KIRO_TERMINAL_QUESTION,
  kiroIdeTerminalAsk,
  kiroIdeTerminalStandingLine,
  kiroTerminalBreakWarning,
  kiroTerminalIssueMessage,
  noteSlowReply,
  readKiroIdeTerminal,
  readKiroTerminalShell,
  recordKiroTerminalShell,
  rejoinCommandPromptQuotes,
  readKiroTerminalAnswer,
  recordKiroTerminalAnswer,
  setKiroIdeTerminalPowerShell,
} from "../../core/tools/aidlc-kiro-ide-terminal.ts";
import * as terminal from "../../core/tools/aidlc-kiro-ide-terminal.ts";
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
  "VSCODE_NONCE", "VSCODE_INJECTION", "VSCODE_STABLE", "VSCODE_A11Y_MODE",
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
    ["config", "--project-dir", project, "--from", DIST_RELEASE, "--harness", "kiro", ...(yes ? ["--yes"] : [])],
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
      "**When a result shows nothing the command printed, not its reply and not an `AI-DLC reply:` line, and ends with " +
        "exit code -1**, Kiro has not been allowed to run commands in this folder yet.",
    );
    expect(skill).not.toContain("When a command comes back with no output and exit code -1");
    expect(skill).not.toContain("When Kiro says your shell is cmd");
  });

  // A live run (#2199): a helper's build and probe commands came back -1 after the person declined
  // them, or while Kiro's prompt to allow them waited for hours; the agent read it as a hung command
  // and the skill's one -1 rule sent it to the trust step.
  test("a -1 on a project command after AI-DLC's own commands ran is a declined or unanswered approval, not an untrusted folder", () => {
    const skill = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain(
      "After AI-DLC's own commands have run in this chat, such a result on one of the project's commands (a build, a test, " +
        "a probe) means Kiro did not run that command: the person declined it, or has not answered Kiro's prompt to allow it yet. " +
        "It is not a timeout and not this folder's trust: do not retry it and do not give the trust step below; tell the " +
        "person, in one line, that Kiro did not run the command and that they can allow it in Kiro or tell you how to go on, " +
        "then end your turn.",
    );
  });

  // A live run (#2200): after one `Command timed out` the agent kept running
  // long chains in the same terminal for four hours, read stale output, and
  // planned to delete AI-DLC's lock files. Measured on Kiro IDE 1.2.4: the
  // terminal answers the very next short command at once, so that is the step;
  // no window reload or new chat is named.
  // Live under Command Prompt (the kiro-cmd investigation): the agent read the
  // one sentence naming lock files as advice and went looking for them, and the
  // `next` exception fed a retry spiral on replies the terminal had dropped.
  test("after a timed-out command the next step is one short read-only command, never the same command again; no lock file and no rerun is named", () => {
    const skill = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain(
      "**When a command comes back with `Command timed out`**, run one short read-only command next (`bun --version` is one) " +
        "to see whether the terminal answers. Never run the timed-out command again to find out: its outcome is unknown, " +
        "so check the state it was meant to change, or tell the person in one line.",
    );
    const paragraph = skill.split("\n").find((line) => line.startsWith("**When a command comes back with `Command timed out`**")) ?? "";
    expect(paragraph).not.toMatch(/same command again|again and again|should finish in seconds/);
    expect(paragraph).not.toContain("The exception is AI-DLC's own `next`");
    expect(skill).not.toContain("lock files");
    expect(skill).not.toContain(".aidlc-audit-");
    expect(skill).not.toMatch(/Command timed out[^\n]*Reload Window/);
  });

  // Live on Windows (Kiro IDE 1.4.86, no shell integration): a long reply came back cut off after the pointer and the
  // agent went on from the cut-off part; another ended at the pointer and the agent went on without reading the file.
  test("a result that ends at an `AI-DLC reply:` line, or is cut off after it, is read from that file, and the command is not run again", () => {
    const skill = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain(
      "**When a result ends at an `AI-DLC reply:` line, or the reply after that line is cut off (a JSON that does not close, " +
        "a list or a sentence that stops mid-way)**, take the next step from the file that line names, not from the result: " +
        "once the command finishes it holds the whole reply, below its first line (the command itself). While the file is not " +
        "there, the command is still running in Kiro's terminal: read it again in a few seconds. If it is still not there after " +
        "a few reads, tell the person in one line that it is still running and may be waiting for their answer in Kiro's " +
        "terminal panel, and end your turn; on your next turn read it again a few times, and if it is still not there, tell them " +
        "in one line that it has not finished yet (a long command can take many minutes, or wait for their answer there) or its " +
        "reply was not saved, then check what it was meant to change. Do not run the command again.",
    );
  });

  test("both Kiro agent prompts say never to send an AI-DLC command's reply to a file", () => {
    const ide = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents", "aidlc-aidlc.md"), "utf-8");
    const cli = (JSON.parse(readFileSync(join(REPO_ROOT, "dist", "kiro", ".kiro", "agents", "aidlc.json"), "utf-8")) as { prompt: string }).prompt;
    for (const prompt of [ide, cli]) {
      expect(prompt).toContain("(5) run AI-DLC's commands as written and read their reply from the command's result: never send it to a file.");
    }
  });
});

// Measured live on Kiro IDE 1.2.37 (the kiro-cmd investigation): without shell
// integration, which cmd.exe never has, Kiro hands the agent whatever a
// command printed within one second and nothing after it, with exit code -1
// for every run. AI-DLC's step commands take one to seven seconds, so under
// Command Prompt most of their replies come back empty. The person is told what
// they meet and can decide (never the mechanism), every Command Prompt chat is
// told the mechanics and the one setter, and a person who kept Command Prompt
// hears once, at the first slow reply, what is happening.
describe("what the question and the diagnostics say breaks", () => {
  test("the question and the doctor message name the empty replies first, then the split words, in the person's terms", () => {
    expect(KIRO_TERMINAL_QUESTION).toContain("In Command Prompt most AI-DLC steps come back with no reply and your words can get split.");
    expect(KIRO_TERMINAL_QUESTION).not.toContain("within a second");
    expect(KIRO_TERMINAL_QUESTION).toContain("Set Kiro's terminal to PowerShell? It is a Kiro setting for all your projects.");
    expect(KIRO_TERMINAL_QUESTION).not.toContain("every command looks like it failed");
    expect(kiroTerminalIssueMessage()).toMatch(/^Kiro runs its agent's commands in Command Prompt/);
    expect(kiroTerminalIssueMessage()).toContain("where most AI-DLC steps come back with no reply and your words can get split");
    expect(kiroTerminalIssueMessage()).not.toContain("within a second");
    expect(kiroTerminalIssueMessage()).not.toContain("every command looks like it failed");
  });
});

describe("every Command Prompt chat gets the standing line", () => {
  const inKiro = (m: ReturnType<typeof machine>) => ({ ...m.env, VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") });
  const INVOKE = "bun .kiro/tools/aidlc.ts";

  test("the line names the one-second rule, the still-running result shape, double quotes and the setter, whatever the person answered", () => {
    const m = machine(CMD_WITH_COMMENTS);
    withEnv(inKiro(m), () => {
      for (const answer of [null, "asked", "kept"] as const) {
        if (answer !== null) recordKiroTerminalAnswer(answer);
        const line = kiroIdeTerminalStandingLine(INVOKE, process.env);
        expect(line, `answer ${answer}`).toContain("Kiro runs your commands in Command Prompt here (your shell tool is still named execute_pwsh");
        expect(line).toContain("hands you a command's reply only when the command finishes within a second");
        expect(line).toContain("only the echoed command and `Exit Code: -1`");
        expect(line).toContain("still running when Kiro read the result, not a failure and not a lock");
        expect(line).toContain("Write values in double quotes in this shell.");
        expect(line).toContain("your shell tool is still named execute_pwsh and PowerShell commands run from it, but the terminal they run in is Command Prompt");
        expect(line).toContain(`the one way is to run \`${INVOKE} config trust --kiro-terminal powershell --yes\` and tell them what it prints; unless they ask, say nothing about it.`);
        expect(line).not.toContain("?");
      }
    });
  });

  test("the ASK ONCE question is unchanged and still asked once beside the standing line", () => {
    const m = machine(CMD_WITH_COMMENTS);
    withEnv(inKiro(m), () => {
      const standing = kiroIdeTerminalStandingLine(INVOKE, process.env);
      const ask = kiroIdeTerminalAsk(INVOKE, process.env);
      expect(ask).toContain("ASK ONCE: after you answer the person's message, ask them this in their language:");
      expect(ask).toContain("Do you want me to set Kiro's terminal to PowerShell? It is a Kiro setting for all your projects.");
      expect(readKiroTerminalAnswer()).toBe("asked");
      expect(kiroIdeTerminalAsk(INVOKE, process.env)).toBe("");
      expect(kiroIdeTerminalStandingLine(INVOKE, process.env)).toBe(standing);
    });
  });

  test("no standing line in PowerShell, outside Kiro IDE, or off Windows", () => {
    const ps = machine(POWERSHELL_SET);
    withEnv(inKiro(ps), () => expect(kiroIdeTerminalStandingLine(INVOKE, process.env)).toBe(""));
    const absent = machine();
    withEnv(inKiro(absent), () => expect(kiroIdeTerminalStandingLine(INVOKE, process.env)).toBe(""));
    const cli = machine(CMD_WITH_COMMENTS);
    withEnv(cli.env, () => expect(kiroIdeTerminalStandingLine(INVOKE, process.env)).toBe(""));
    const mac = machine(CMD_WITH_COMMENTS, "darwin");
    withEnv(inKiro(mac), () => expect(kiroIdeTerminalStandingLine(INVOKE, process.env)).toBe(""));
  });
});

describe("the warning once, at the first slow reply, for a person who kept Command Prompt", () => {
  const inKiro = (m: ReturnType<typeof machine>) => ({ ...m.env, VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") });
  // The engine's own commands run in Kiro's terminal: TERM_PROGRAM=kiro, no VSCODE_CODE_CACHE_PATH (measured).
  const inTerminal = (m: ReturnType<typeof machine>) => ({ ...m.env, TERM_PROGRAM: "kiro" });
  const dropped = (m: ReturnType<typeof machine>) => join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-dropped");
  const warned = (m: ReturnType<typeof machine>) => join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-warned");

  test("a tool run over one second in Kiro's Command Prompt terminal notes the dropped reply, once the person kept or was asked", () => {
    for (const answer of ["kept", "asked"] as const) {
      const m = machine(CMD_WITH_COMMENTS);
      withEnv(inTerminal(m), () => {
        recordKiroTerminalAnswer(answer);
        noteSlowReply(800, process.env);
        expect(existsSync(dropped(m)), `${answer} under a second`).toBe(false);
        noteSlowReply(1500, process.env);
        expect(existsSync(dropped(m)), `${answer} over a second`).toBe(true);
      });
    }
    const unanswered = machine(CMD_WITH_COMMENTS);
    withEnv(inTerminal(unanswered), () => {
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(unanswered))).toBe(false);
    });
    const switched = machine(CMD_WITH_COMMENTS);
    withEnv(inTerminal(switched), () => {
      recordKiroTerminalAnswer("powershell");
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(switched))).toBe(false);
    });
    const powershell = machine(POWERSHELL_SET);
    withEnv(inTerminal(powershell), () => {
      recordKiroTerminalAnswer("kept");
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(powershell))).toBe(false);
    });
    const ownTerminal = machine(CMD_WITH_COMMENTS);
    withEnv(ownTerminal.env, () => {
      recordKiroTerminalAnswer("kept");
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(ownTerminal))).toBe(false);
    });
    const mac = machine(CMD_WITH_COMMENTS, "darwin");
    withEnv(inTerminal(mac), () => {
      recordKiroTerminalAnswer("kept");
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(mac))).toBe(false);
    });
  });

  test("the chat's hook records which shell the running Kiro has, and the engine's own commands go by that record", () => {
    // The agent's commands carry no VSCODE_CODE_CACHE_PATH, so a portable Kiro or a custom user data folder
    // would be read from Kiro's default settings folder; the hook saw the running Kiro's settings.
    const portable = machine(POWERSHELL_SET);
    withEnv(inKiro({ ...portable, env: { ...portable.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(portable.root, "running-kiro.json") } }), () => {
      mkdirSync(join(portable.root), { recursive: true });
      writeFileSync(join(portable.root, "running-kiro.json"), CMD_WITH_COMMENTS);
      recordKiroTerminalShell(process.env);
      expect(readKiroTerminalShell()).toBe("cmd");
    });
    withEnv(inTerminal(portable), () => {
      recordKiroTerminalAnswer("kept");
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(portable))).toBe(true);
    });
    const switched = machine(CMD_WITH_COMMENTS);
    withEnv(inKiro({ ...switched, env: { ...switched.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(switched.root, "running-kiro.json") } }), () => {
      writeFileSync(join(switched.root, "running-kiro.json"), POWERSHELL_SET);
      recordKiroTerminalShell(process.env);
      expect(readKiroTerminalShell()).toBe("powershell");
    });
    withEnv(inTerminal(switched), () => {
      recordKiroTerminalAnswer("kept");
      noteSlowReply(1500, process.env);
      expect(existsSync(dropped(switched))).toBe(false);
    });
    const cli = machine(CMD_WITH_COMMENTS);
    withEnv(cli.env, () => {
      recordKiroTerminalShell(process.env);
      expect(readKiroTerminalShell()).toBeNull();
    });
    const mac = machine(CMD_WITH_COMMENTS, "darwin");
    withEnv(inKiro(mac), () => {
      recordKiroTerminalShell(process.env);
      expect(readKiroTerminalShell()).toBeNull();
    });
  });

  test("the next hook run in the chat says it once to the person, in one line with no question, and never again on this machine", () => {
    const m = machine(CMD_WITH_COMMENTS);
    withEnv(inKiro(m), () => {
      recordKiroTerminalAnswer("kept");
      expect(kiroTerminalBreakWarning(process.env)).toBe("");
    });
    withEnv(inTerminal(m), () => noteSlowReply(1500, process.env));
    withEnv(inKiro(m), () => {
      const line = kiroTerminalBreakWarning(process.env);
      expect(line).toContain("Tell the person this once, in their language, then go on with their request:");
      expect(line).toContain("Kiro's Command Prompt terminal is cutting off AI-DLC's replies, so steps here take extra turns.");
      expect(line).toContain("Tell me if you want Kiro's terminal set to PowerShell, which avoids this.");
      expect(line).not.toContain("within a second");
      expect(line).not.toContain("?");
      expect(existsSync(warned(m))).toBe(true);
      expect(existsSync(dropped(m))).toBe(false);
      expect(kiroTerminalBreakWarning(process.env)).toBe("");
    });
    withEnv(inTerminal(m), () => {
      noteSlowReply(3000, process.env);
      expect(existsSync(dropped(m))).toBe(false);
    });
    withEnv(inKiro(m), () => expect(kiroTerminalBreakWarning(process.env)).toBe(""));
  });

  // Live on Kiro IDE 1.2.37: a line handed over before a tool call was
  // swallowed by the agent mid-chain; one that comes with the person's own
  // message is answered, so the person's message hook carries it.
  test("the person's message hook carries the line with the answer to their next message, and only that once", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    withEnv(inTerminal(m), () => {
      recordKiroTerminalAnswer("kept");
      noteSlowReply(1500, process.env);
    });
    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: project,
      session_id: "sess_kiro_terminal",
      prompt: "Set Kiro's terminal to PowerShell.",
    });
    const run = () =>
      spawnSync(process.execPath, [join(project, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"], {
        cwd: project,
        input: payload,
        encoding: "utf-8",
        env: childEnv({ ...inKiro(m), CLAUDE_PROJECT_DIR: project }),
      });
    const first = run();
    expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
    expect(first.stdout).toContain("Tell me if you want Kiro's terminal set to PowerShell, which avoids this.");
    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("cutting off AI-DLC's replies");
  });
});

describe("the setter when there is nothing to set", () => {
  test("`config trust --kiro-terminal powershell --yes` on a PowerShell machine says so, writes nothing, and keeps the answer", () => {
    const m = machine(POWERSHELL_SET);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    const set = runInit(["config", "trust", "--project-dir", project, "--kiro-terminal", "powershell", "--yes"], project, m.env);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain("Kiro's terminal is already PowerShell.");
    expect(set.out).not.toContain("Set Kiro's terminal to PowerShell");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(POWERSHELL_SET);
    withEnv(m.env, () => expect(readKiroTerminalAnswer()).toBe("powershell"));

    const absent = machine();
    const other = installKiroIde({ ...absent.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(absent.root, "none.json") });
    const kept = runInit(
      ["config", "trust", "--project-dir", other.project, "--kiro-terminal", "powershell"],
      other.project,
      { ...absent.env, AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "" },
    );
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain("Kiro's terminal is already PowerShell.");
    expect(kept.out).not.toContain("[Y/n]");
    expect(existsSync(absent.settingsPath)).toBe(false);
  });
});

// Kiro's Command Prompt terminal hands the agent whatever a command printed
// within one second and drops the rest (measured on Kiro IDE 1.2.37). A tool
// that runs in that terminal prints one pointer line first, runs itself as a
// child, relays the child's reply and writes it to a file the pointer names,
// so the agent reads a reply the terminal dropped or cut off instead of
// running the command again. Nowhere else does the tool behave differently.
describe("the reply file and its pointer under Command Prompt", () => {
  const TOOL = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
  const POINTER = /^AI-DLC reply: (aidlc\/\.aidlc-sessions\/replies\/[a-z0-9-]+\.txt) \(Command Prompt shows a reply only when it is ready within a second; when this result ends here or its reply is cut off, go on from that file, which holds the whole reply once the command finishes; until it appears, the command is still running\)$/m;
  function project(): string {
    const dir = temp("aidlc-t-kiro-terminal-tee-");
    mkdirSync(join(dir, "aidlc"), { recursive: true });
    return dir;
  }
  // The agent's own commands: Kiro's terminal (TERM_PROGRAM), no user-data env, the shell as the hook recorded it.
  function inTerminal(m: ReturnType<typeof machine>, shell: "cmd" | "powershell" | null): Record<string, string> {
    if (shell !== null) {
      mkdirSync(m.env.AIDLC_INSTALL_ROOT, { recursive: true });
      writeFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-shell"), `${shell}\n`);
    }
    // Kiro's terminal is both ends of the agent's command (measured); the runner's pipes are not.
    return childEnv({ ...m.env, TERM_PROGRAM: "kiro", AIDLC_TEST_CONFIG_TTY: "1" });
  }
  function run(args: string[], cwd: string, env: Record<string, string>) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, env, encoding: "utf-8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("the pointer comes first, the reply follows and lands in the file the pointer names, once", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const dir = project();
    const r = run(["version"], dir, inTerminal(m, "cmd"));
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((line) => line !== "");
    expect(lines[0]).toMatch(POINTER);
    expect(lines[1]).toMatch(/^aidlc \d/);
    expect(lines.filter((line) => line.startsWith("AI-DLC reply:")).length).toBe(1);
    const file = POINTER.exec(r.stdout)![1];
    const text = readFileSync(join(dir, file), "utf-8");
    expect(text.split("\n")[0]).toMatch(/^# .*aidlc-utility\.ts version$/);
    expect(text).toContain(lines[1]);
    expect(text).not.toContain("AI-DLC reply:");
  });

  // The child's output is held past Kiro's one-second read, then relayed as it
  // is produced, never kept until exit: the agent's result keeps its shape, and
  // a question a command asks on the terminal shows while it waits for the
  // answer (a person at Kiro's own terminal panel can give it).
  test("the child's output reaches the terminal while the child still runs, after the hold", async () => {
    const dir = temp("aidlc-t-kiro-terminal-relay-");
    const driver = join(dir, "driver.ts");
    writeFileSync(
      driver,
      `import { relayCommandPromptChild } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-kiro-ide-terminal.ts"))};\n` +
        `const child = Bun.spawn([process.execPath, "-e", "console.log('early'); await Bun.sleep(3500); console.log('late'); process.exit(3)"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });\n` +
        `const r = await relayCommandPromptChild(child);\n` +
        `process.stderr.write(JSON.stringify(r));\n`,
    );
    const startedAt = Date.now();
    const proc = Bun.spawn([process.execPath, driver], { cwd: dir, env: childEnv({}), stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader();
    const first = await reader.read();
    const firstAt = Date.now();
    expect(new TextDecoder().decode(first.value)).toContain("early");
    expect(firstAt - startedAt).toBeGreaterThanOrEqual(1500);
    const code = await proc.exited;
    expect(Date.now() - firstAt).toBeGreaterThan(1000);
    expect(code).toBe(0);
    const rest = await new Response(proc.stderr).text();
    expect(JSON.parse(rest)).toEqual({ code: 3, stdout: "early\nlate\n", stderr: "" });
  });

  // A compiled binary's argv is ["bun", "/$bunfs/root/<entry>", ...args], so
  // the respawn drops the embedded entry there and keeps the script path only
  // when bun runs the source (measured with `bun build --compile`, bun 1.3.14).
  test("the child command is the same tool again: the script under bun, the binary's own arguments when compiled", () => {
    expect(terminal.commandPromptChildCommand(["/usr/bin/bun", "/p/.kiro/tools/aidlc-utility.ts", "version"], "/usr/bin/bun", false))
      .toEqual(["/usr/bin/bun", "/p/.kiro/tools/aidlc-utility.ts", "version"]);
    expect(terminal.commandPromptChildCommand(["bun", "/$bunfs/root/aidlc", "engine", "orchestrate", "next"], "C:\\aidlc\\bin\\aidlc.exe", true))
      .toEqual(["C:\\aidlc\\bin\\aidlc.exe", "engine", "orchestrate", "next"]);
  });

  test("the child's exit code and stderr come through", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const dir = project();
    const r = run(["no-such-subcommand-for-the-tee-test"], dir, inTerminal(m, "cmd"));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(POINTER);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain("no-such-subcommand-for-the-tee-test");
  });

  test("no pointer and no file in PowerShell, outside Kiro's terminal, without a shell record on a PowerShell machine, or where no aidlc/ folder is", () => {
    const ps = machine(CMD_WITH_COMMENTS);
    const d1 = project();
    const inPs = run(["version"], d1, inTerminal(ps, "powershell"));
    expect(`${inPs.stdout}${inPs.stderr}`).not.toContain("AI-DLC reply:");
    const own = machine(CMD_WITH_COMMENTS);
    writeFileSync(join(mkdirSync(own.env.AIDLC_INSTALL_ROOT, { recursive: true }) ?? own.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-shell"), "cmd\n");
    const outside = run(["version"], project(), childEnv({ ...own.env, AIDLC_TEST_CONFIG_TTY: "1" }));
    expect(`${outside.stdout}${outside.stderr}`).not.toContain("AI-DLC reply:");
    const unrecorded = machine(POWERSHELL_SET);
    const noRecord = run(["version"], project(), inTerminal(unrecorded, null));
    expect(`${noRecord.stdout}${noRecord.stderr}`).not.toContain("AI-DLC reply:");
    const bare = temp("aidlc-t-kiro-terminal-tee-bare-");
    const noFolder = run(["version"], bare, inTerminal(machine(CMD_WITH_COMMENTS), "cmd"));
    expect(`${noFolder.stdout}${noFolder.stderr}`).not.toContain("AI-DLC reply:");
    expect(existsSync(join(bare, "aidlc"))).toBe(false);
  });

  test("a recorded Command Prompt without a settings file still tees, and the newest twenty replies are kept", () => {
    const m = machine();
    const dir = project();
    const replies = join(dir, "aidlc", ".aidlc-sessions", "replies");
    mkdirSync(replies, { recursive: true });
    for (let i = 10; i < 35; i++) writeFileSync(join(replies, `0000000${i}-1.txt`), "old\n");
    const r = run(["version"], dir, inTerminal(m, "cmd"));
    expect(r.stdout).toMatch(POINTER);
    const kept = readdirSync(replies).sort();
    expect(kept.length).toBe(20);
    expect(kept[0]).toBe("000000016-1.txt");
    expect(readFileSync(join(dir, POINTER.exec(r.stdout)![1]), "utf-8")).toMatch(/aidlc \d/);
  });
});

// cmd.exe passes single quotes on as characters, so a value the agent wrote
// for PowerShell (`'fix the greeter'`) arrives as several arguments with the
// quotes attached to the first and the last. The pair a shell should have
// eaten is structure, not meaning: under Command Prompt the tool joins the
// group back into one argument and drops that one pair; nothing else changes.
describe("the quote pair Command Prompt left on the words", () => {
  const cmd = (m: ReturnType<typeof machine>) => {
    mkdirSync(m.env.AIDLC_INSTALL_ROOT, { recursive: true });
    writeFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-shell"), "cmd\n");
    return { ...m.env, TERM_PROGRAM: "kiro" };
  };

  test("one group per pair, joined with spaces and stripped of the pair; a quote of the person's own inside stays", () => {
    const m = machine(CMD_WITH_COMMENTS);
    withEnv(cmd(m), () => {
      expect(rejoinCommandPromptQuotes(["next", "--plan-approval", "off", "'fix", "the", "greeter:", "hello'"], process.env))
        .toEqual(["next", "--plan-approval", "off", "fix the greeter: hello"]);
      expect(rejoinCommandPromptQuotes(["decision", "--stage", "feasibility", "--decision", "'Chose", "Option", "A'"], process.env))
        .toEqual(["decision", "--stage", "feasibility", "--decision", "Chose Option A"]);
      expect(rejoinCommandPromptQuotes(["--details", "''tis", "the", "season'"], process.env)).toEqual(["--details", "'tis the season"]);
      expect(rejoinCommandPromptQuotes(["--details", "'one'", "--reason", "'two", "words'"], process.env))
        .toEqual(["--details", "one", "--reason", "two words"]);
      expect(rejoinCommandPromptQuotes(["--details", "'tis", "the", "season"], process.env)).toEqual(["--details", "'tis", "the", "season"]);
      expect(rejoinCommandPromptQuotes(["--details", "Rename", "\"Tasks\""], process.env)).toEqual(["--details", "Rename", "\"Tasks\""]);
    });
  });

  test("nothing changes outside Kiro's Command Prompt terminal", () => {
    const args = ["next", "'fix", "the", "greeter'"];
    const ps = machine(CMD_WITH_COMMENTS);
    mkdirSync(ps.env.AIDLC_INSTALL_ROOT, { recursive: true });
    writeFileSync(join(ps.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-shell"), "powershell\n");
    withEnv({ ...ps.env, TERM_PROGRAM: "kiro" }, () => expect(rejoinCommandPromptQuotes(args, process.env)).toEqual(args));
    const own = machine(CMD_WITH_COMMENTS);
    withEnv(cmd(own), () => {
      delete process.env.TERM_PROGRAM;
      expect(rejoinCommandPromptQuotes(args, process.env)).toEqual(args);
    });
  });

  test("the request after next and a log value arrive whole in the record", () => {
    const m = machine(CMD_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    mkdirSync(m.env.AIDLC_INSTALL_ROOT, { recursive: true });
    writeFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-shell"), "cmd\n");
    // A chat message came first, as in any Kiro IDE chat: the adapter leaves the heartbeat that tells the engine Kiro runs the hooks.
    const hello = spawnSync(process.execPath, [join(project, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"], {
      cwd: project,
      input: "",
      encoding: "utf-8",
      env: childEnv({ ...m.env, CLAUDE_PROJECT_DIR: project, VSCODE_IPC_HOOK: `test-ipc:${project}`, VSCODE_PID: "1", USER_PROMPT: "hello" }),
    });
    expect(hello.status, hello.stderr).toBe(0);
    const env = childEnv({ ...m.env, TERM_PROGRAM: "kiro", AIDLC_CMD_REPLY_TEE: "1" });
    const next = spawnSync(process.execPath, [join(project, ".kiro", "tools", "aidlc-orchestrate.ts"), "next", "'fix", "the", "greeter:", "it", "prints", "hello'"], {
      cwd: project,
      env,
      encoding: "utf-8",
    });
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toContain("fix the greeter: it prints hello");
    expect(next.stdout).not.toContain("'fix the greeter");
  });
});

// Kiro starts PowerShell with its shell integration script, and the script's
// first lines clear VSCODE_NONCE. When an execution policy of Restricted or
// AllSigned stops the unsigned script (VSCODE_INJECTION=1 and VSCODE_A11Y_MODE
// stay), or Kiro's shell integration setting is off (neither), the nonce stays
// in every command and the terminal behaves as Command Prompt does: exit code
// -1 for every run, a reply only within a second (measured on Kiro IDE 1.4.86,
// Windows PowerShell 5.1). AI-DLC's commands there keep their reply in a file
// too, and doctor run in that terminal names what to check.
describe("a PowerShell terminal whose shell integration did not run", () => {
  const TOOL = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
  const POINTER = /^AI-DLC reply: (aidlc\/\.aidlc-sessions\/replies\/[a-z0-9-]+\.txt) \(Kiro's terminal here runs without its shell integration, so it shows a reply only when it is ready within a second and every result ends with exit code -1; when this result ends here or its reply is cut off, go on from that file, which holds the whole reply once the command finishes; until it appears, the command is still running\)$/m;
  const BLOCKED = { VSCODE_NONCE: "05a79338-0192-4df2-9a5f-b69cc08579cd", VSCODE_INJECTION: "1", VSCODE_STABLE: "1", VSCODE_A11Y_MODE: "0" };
  const SETTING_OFF = { VSCODE_NONCE: "1ddc280d-fa22-4fd4-b0fd-b637a85c8660" };
  const LOADED = { VSCODE_INJECTION: "1" };
  function inTerminal(m: ReturnType<typeof machine>, shell: "cmd" | "powershell", vars: Record<string, string>): Record<string, string> {
    mkdirSync(m.env.AIDLC_INSTALL_ROOT, { recursive: true });
    writeFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-terminal-shell"), `${shell}\n`);
    return childEnv({ ...m.env, TERM_PROGRAM: "kiro", AIDLC_TEST_CONFIG_TTY: "1", ...vars });
  }
  function project(): string {
    const dir = temp("aidlc-t-kiro-terminal-integration-");
    mkdirSync(join(dir, "aidlc"), { recursive: true });
    return dir;
  }
  function run(args: string[], cwd: string, env: Record<string, string>) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, env, encoding: "utf-8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("an AI-DLC command prints the pointer first and keeps its reply in the file, with the script stopped or the setting off", () => {
    for (const vars of [BLOCKED, SETTING_OFF]) {
      const m = machine(POWERSHELL_SET);
      const dir = project();
      const r = run(["version"], dir, inTerminal(m, "powershell", vars));
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.split("\n").filter((line) => line !== "");
      expect(lines[0]).toMatch(POINTER);
      expect(lines[1]).toMatch(/^aidlc \d/);
      expect(lines.filter((line) => line.startsWith("AI-DLC reply:")).length).toBe(1);
      expect(readFileSync(join(dir, POINTER.exec(r.stdout)![1]), "utf-8")).toContain(lines[1]);
    }
  });

  test("nothing changes where the script ran, outside Kiro's terminal, off Windows, or in Command Prompt", () => {
    const m = machine(POWERSHELL_SET);
    const dir = project();
    for (const env of [
      inTerminal(m, "powershell", LOADED),
      childEnv({ ...m.env, AIDLC_TEST_CONFIG_TTY: "1", ...BLOCKED }),
      inTerminal(machine(POWERSHELL_SET, "darwin"), "powershell", BLOCKED),
    ]) {
      const r = run(["version"], dir, env);
      expect(`${r.stdout}${r.stderr}`).not.toContain("AI-DLC reply:");
    }
    const inCmd = run(["version"], dir, inTerminal(machine(CMD_WITH_COMMENTS), "cmd", BLOCKED));
    expect(inCmd.stdout).toContain("(Command Prompt shows a reply only when it is ready within a second;");
    expect(inCmd.stdout).not.toContain("shell integration");
  });

  // `config` runs itself again and reads the child's JSON; a person pipes `--json` output; neither is a terminal.
  test("no pointer where the output goes to a pipe, or where no aidlc/ folder is", () => {
    const m = machine(POWERSHELL_SET);
    const { AIDLC_TEST_CONFIG_TTY: _tty, ...piped } = inTerminal(m, "powershell", BLOCKED);
    const toPipe = run(["version"], project(), piped);
    expect(toPipe.status, toPipe.stderr).toBe(0);
    expect(`${toPipe.stdout}${toPipe.stderr}`).not.toContain("AI-DLC reply:");
    const bare = temp("aidlc-t-kiro-terminal-integration-bare-");
    const noFolder = run(["version"], bare, inTerminal(m, "powershell", BLOCKED));
    expect(`${noFolder.stdout}${noFolder.stderr}`).not.toContain("AI-DLC reply:");
    expect(existsSync(join(bare, "aidlc"))).toBe(false);
  });

  // Claude Code or Codex started from that terminal carries its variables into its hooks, which read the tool's
  // output as their structured reply, as the status line's host does.
  test("a host's hook, adapter or status line, read through a pipe, gets no pointer, here or in Command Prompt", () => {
    const dispatcher = join(REPO_ROOT, "core", "tools", "aidlc.ts");
    const dir = project();
    // Command Prompt first: there the base tees these routes too. A host reads its hook's output through a pipe.
    for (const env of [inTerminal(machine(CMD_WITH_COMMENTS), "cmd", {}), inTerminal(machine(POWERSHELL_SET), "powershell", BLOCKED)]) {
      const { AIDLC_TEST_CONFIG_TTY: _tty, ...hostPipe } = env;
      for (const args of [["engine", "hook", "no-such-hook-for-the-tee-test"], ["engine", "statusline"], ["engine", "adapter", "codex", "no-such-target"]]) {
        const r = spawnSync(process.execPath, [dispatcher, ...args], { cwd: dir, env: hostPipe, input: "{}", encoding: "utf-8" });
        expect(`${r.stdout}${r.stderr}`, args.join(" ")).not.toContain("AI-DLC reply:");
      }
      // A public command in the same terminal still tees.
      const version = spawnSync(process.execPath, [dispatcher, "version"], { cwd: dir, env, encoding: "utf-8" });
      expect(version.stdout).toContain("AI-DLC reply:");
    }
  });

  test("PowerShell's own quoting is left alone: no Command Prompt quote rejoin", () => {
    const m = machine(POWERSHELL_SET);
    const args = ["next", "'fix", "the", "greeter'"];
    withEnv(inTerminal(m, "powershell", BLOCKED), () => expect(rejoinCommandPromptQuotes(args, process.env)).toEqual(args));
  });

  test("doctor run in that terminal warns with the step for what it sees; elsewhere it keeps the profile row", () => {
    const m = machine(POWERSHELL_SET);
    const { project: dir } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    withEnv(m.env, () => {
      const blocked = kiroIdeTerminalDoctorCheck(dir, ".kiro", inTerminal(m, "powershell", BLOCKED));
      expect(blocked).toMatchObject({ pass: false, severity: "warn" });
      expect(blocked?.label).toBe("Kiro terminal: this terminal runs without Kiro's shell integration, so every command shows exit code -1 and output after its first second is cut off (AI-DLC keeps its own replies in a file)");
      expect(blocked?.fix).toContain("in Kiro's PowerShell terminal, run `Get-ExecutionPolicy -List` and `$ExecutionContext.SessionState.LanguageMode`");
      expect(blocked?.fix).toContain("when MachinePolicy or UserPolicy is set, or the language mode is not FullLanguage, your organization manages it");
      expect(blocked?.fix).toContain("when Process is set, Kiro took it from where it was started: start Kiro from the Start menu instead");
      expect(blocked?.fix).toContain("when the policy in effect comes from CurrentUser or LocalMachine and is Restricted or AllSigned, `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`");
      expect(blocked?.fix).toContain("restart Kiro");
      const off = kiroIdeTerminalDoctorCheck(dir, ".kiro", inTerminal(m, "powershell", SETTING_OFF));
      expect(off?.fix).toContain("`terminal.integrated.shellIntegration.enabled` is on");
      expect(off?.fix).not.toContain("ExecutionPolicy");
      // Kiro sets VSCODE_A11Y_MODE only for PowerShell's script: without it no PowerShell script was started.
      const other = kiroIdeTerminalDoctorCheck(dir, ".kiro", inTerminal(m, "powershell", { VSCODE_NONCE: "n", VSCODE_INJECTION: "1" }));
      expect(other?.fix).not.toContain("ExecutionPolicy");
      expect(kiroIdeTerminalDoctorCheck(dir, ".kiro", inTerminal(m, "powershell", LOADED)))
        .toEqual({ pass: true, label: "Kiro terminal: PowerShell" });
      expect(kiroIdeTerminalDoctorCheck(dir, ".kiro", m.env)).toEqual({ pass: true, label: "Kiro terminal: PowerShell" });
    });
  });

  test("the agent reads an empty -1 there as cut off, not as trust or a declined command, and names the check once", () => {
    const skill = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain(
      "When an `AI-DLC reply:` line in this chat said Kiro's terminal here runs without its shell integration, every command " +
        "ends with exit code -1 in this terminal whatever its outcome (read a result that shows output by what it printed, " +
        "not by that code), so a result that shows nothing is a command whose output was cut off, that may still be " +
        "running, or that Kiro did not run, and neither reading below applies: do not run it again to see its output;",
    );
    expect(skill).toMatch(
      /\*\*When an `AI-DLC reply:` line says Kiro's terminal here runs without its shell integration\*\*, whether or not the reply after it is whole, tell the person this once in the chat, in their language, then go on with their request: "Kiro's terminal here runs without its shell integration, so every command shows exit code -1, replies that take over a second are cut off, and steps take extra turns\. `[^`]+ doctor` run in Kiro's terminal says why and what to change\."/,
    );
    // The agent does not run doctor itself: it would cost a command in this terminal, and the skill's utility route
    // (`engine orchestrate next --doctor`) is a turn-ending print that would stop the person's work.
    expect(skill).not.toMatch(/run `[^`]*doctor` and tell the person/);
  });
});
