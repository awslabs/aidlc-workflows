// Kiro IDE's Workflows feature takes the sub-agent tool away from a chat and
// hands AI-DLC's reviews and helpers to background workflows (measured on Kiro
// IDE 1.2.37). Its switch, `kiroAgent.workflows.enabled`, lives only in Kiro's
// user settings, so it covers every project: AI-DLC turns it off when the person
// says yes (setup, `config --yes`, a chat), keeps their answer once per machine,
// and never touches any other byte of their settings file. Kiro CLI, the row's
// other host, has its own switch (`chat.enableWorkflows`, measured on Kiro CLI
// 2.31.1 and 2.32.0) with the same question and an answer of its own.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import {
  kiroIdeUserSettingsPath,
  kiroIdeWorkflowsAsk,
  readKiroIdeWorkflows,
  readKiroWorkflowsAnswer,
  recordKiroWorkflowsAnswer,
  setKiroIdeWorkflows,
} from "../../core/tools/aidlc-kiro-ide-workflows.ts";
import {
  kiroIdeWorkflowsDoctorCheck,
  postApplyOutstandingActions,
  trustStatus,
} from "../../core/tools/aidlc-config-diagnostics.ts";

setDefaultTimeout(120_000);

const KEY = "kiroAgent.workflows.enabled";
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const HOST_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "KIRO_SESSION_ID", "OPENCODE",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "VSCODE_CODE_CACHE_PATH",
  "AIDLC_TEST_KIRO_IDE_SETTINGS", "AIDLC_TEST_CONFIG_DETECTION_JSON", "AIDLC_TEST_KIRO_SESSION_JSON", "KIRO_HOME",
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

// A machine of its own: AI-DLC's install root (the kept answer) and Kiro IDE's
// user settings file, both in a temporary folder.
function machine(settings?: string): { env: Record<string, string>; settingsPath: string; root: string } {
  const root = temp("aidlc-kiro-workflows-");
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
      // The runner sets it too; named here so a plain `bun test` of this file
      // never reaches the person's own kiro-cli and Kiro CLI settings.
      AIDLC_TEST_NAME: "t-kiro-ide-workflows",
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
  const project = temp("aidlc-t-kiro-workflows-project-");
  mkdirSync(join(project, ".git"));
  const result = runInit(
    ["config", "--project-dir", project, "--from", DIST_RELEASE, "--harness", "kiro", ...(yes ? ["--yes"] : [])],
    project,
    extra,
  );
  expect(result.status, result.out).toBe(0);
  return { project, out: result.out };
}

const ON_WITH_COMMENTS = `{
  // my editor
  "editor.fontSize": 14,
  "${KEY}": true, // Kiro wrote this
  "kiroAgent.trust.defaultScope": "workspace",
}
`;

const MISSING_COMMA = `{
  "editor.fontSize": 14
  "${KEY}": true
}
`;

describe("Kiro IDE's user settings file", () => {
  test("inside Kiro IDE it is the running Kiro's user data folder; elsewhere Kiro's default folder", () => {
    expect(kiroIdeUserSettingsPath({ VSCODE_CODE_CACHE_PATH: join("C:", "ud", "CachedData", "2d86910a") }, "win32"))
      .toBe(join("C:", "ud", "User", "settings.json"));
    expect(kiroIdeUserSettingsPath({ APPDATA: join("C:", "Users", "a", "AppData", "Roaming") }, "win32"))
      .toBe(join("C:", "Users", "a", "AppData", "Roaming", "Kiro", "User", "settings.json"));
    expect(kiroIdeUserSettingsPath({ HOME: "/Users/a" }, "darwin"))
      .toBe(join("/Users/a", "Library", "Application Support", "Kiro", "User", "settings.json"));
    expect(kiroIdeUserSettingsPath({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" }, "linux"))
      .toBe(join("/xdg", "Kiro", "User", "settings.json"));
    expect(kiroIdeUserSettingsPath({ HOME: "/home/a" }, "linux")).toBe(join("/home/a", ".config", "Kiro", "User", "settings.json"));
    // Under the test runner only the seam reaches a settings file.
    expect(kiroIdeUserSettingsPath({ AIDLC_TEST_NAME: "t", HOME: "/home/a" }, "linux")).toBeNull();
  });

  test("Workflows is on only when the key is exactly true; an absent file or key is Kiro's default, off", () => {
    expect(readKiroIdeWorkflows(machine().env).enabled).toBe(false);
    expect(readKiroIdeWorkflows(machine("{}\n").env).enabled).toBe(false);
    expect(readKiroIdeWorkflows(machine(`{ "${KEY}": false }`).env).enabled).toBe(false);
    expect(readKiroIdeWorkflows(machine(ON_WITH_COMMENTS).env)).toMatchObject({ enabled: true, readable: true });
    expect(readKiroIdeWorkflows(machine("{ not json").env)).toMatchObject({ enabled: false, readable: false });
  });

  test("turning it off changes that one value and keeps every other byte", () => {
    const m = machine(ON_WITH_COMMENTS);
    expect(setKiroIdeWorkflows(false, m.env)).toEqual({ settingsPath: m.settingsPath, changed: true });
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS.replace(`"${KEY}": true`, `"${KEY}": false`));
    expect(setKiroIdeWorkflows(false, m.env).changed).toBe(false);
    expect(setKiroIdeWorkflows(true, m.env).changed).toBe(true);
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS);
  });

  test("a missing file or key gets the one key; a file AI-DLC cannot edit is left alone with Kiro's own command named", () => {
    const absent = machine();
    setKiroIdeWorkflows(true, absent.env);
    expect(JSON.parse(readFileSync(absent.settingsPath, "utf-8"))).toEqual({ [KEY]: true });
    const other = machine(`{\n  "editor.fontSize": 14\n}\n`);
    setKiroIdeWorkflows(false, other.env);
    expect(readFileSync(other.settingsPath, "utf-8")).toBe(`{\n  "editor.fontSize": 14,\n  "${KEY}": false\n}\n`);
    const broken = machine("{ not json");
    expect(() => setKiroIdeWorkflows(false, broken.env)).toThrow("run Disable Workflows from the Command Palette");
    expect(readFileSync(broken.settingsPath, "utf-8")).toBe("{ not json");
  });

  test.skipIf(process.platform === "win32")("a settings file linked from elsewhere (a dotfiles folder) stays a link; the file it points to changes", () => {
    const m = machine();
    const dotfiles = join(m.root, "dotfiles", "kiro-settings.json");
    mkdirSync(join(m.root, "dotfiles"), { recursive: true });
    writeFileSync(dotfiles, ON_WITH_COMMENTS);
    mkdirSync(join(m.root, "Kiro", "User"), { recursive: true });
    symlinkSync(dotfiles, m.settingsPath);
    expect(setKiroIdeWorkflows(false, m.env)).toEqual({ settingsPath: m.settingsPath, changed: true });
    expect(lstatSync(m.settingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(dotfiles, "utf-8")).toBe(ON_WITH_COMMENTS.replace(`"${KEY}": true`, `"${KEY}": false`));
  });

  test("the person's answer is kept once per machine", () => {
    const m = machine();
    withEnv(m.env, () => {
      expect(readKiroWorkflowsAnswer()).toBeNull();
      recordKiroWorkflowsAnswer("on");
      expect(readKiroWorkflowsAnswer()).toBe("on");
      expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-workflows"), "utf-8")).toBe("on\n");
    });
  });
});

// Bun loads the .env files of the folder it runs in, as it does for
// `bun .kiro/tools/aidlc.ts` in a cloned repository. These run a child Bun in
// such a folder with only the person's own environment.
describe("a project's .env file", () => {
  const MODULE = join(REPO_ROOT, "core", "tools", "aidlc-kiro-ide-workflows.ts");
  const CHILD = `import * as w from ${JSON.stringify(MODULE)};
const path = w.kiroIdeUserSettingsPath();
const due = w.kiroWorkflowsQuestionDue();
const ask = w.kiroIdeWorkflowsAsk("aidlc");
const set = path === null ? null : w.setKiroIdeWorkflows(false).settingsPath;
console.log(JSON.stringify({ path, due, ask, set }));`;

  // Kiro's default settings file for this platform under the person's home.
  function ownSettings(home: string): string {
    const base = process.platform === "win32"
      ? join(home, "AppData", "Roaming")
      : process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : join(home, ".config");
    return join(base, "Kiro", "User", "settings.json");
  }

  function inProject(dotenv: (project: string) => string, settingsFor: (home: string) => string, extra: (home: string) => Record<string, string> = () => ({})) {
    const home = temp("aidlc-kiro-workflows-home-");
    const project = temp("aidlc-kiro-workflows-dotenv-");
    writeFileSync(join(project, ".env"), dotenv(project));
    const settings = settingsFor(home);
    mkdirSync(join(settings, ".."), { recursive: true });
    writeFileSync(settings, ON_WITH_COMMENTS);
    const result = spawnSync(process.execPath, ["-e", CHILD], {
      cwd: project,
      encoding: "utf-8",
      env: {
        PATH: "",
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        AIDLC_INSTALL_ROOT: join(home, "aidlc"),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...extra(home),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout.trim()) as { path: string | null; due: boolean; ask: string; set: string | null };
    return { home, project, settings, seen };
  }

  test("cannot point AI-DLC at a settings file of its choosing", () => {
    const run = inProject((project) => `XDG_CONFIG_HOME=${join(project, "repo-config")}\nAPPDATA=${join(project, "repo-config")}\n`, ownSettings);
    expect(run.seen).toMatchObject({ path: run.settings, due: true, set: run.settings });
    expect(readFileSync(run.settings, "utf-8")).toBe(ON_WITH_COMMENTS.replace(`"${KEY}": true`, `"${KEY}": false`));
    expect(existsSync(join(run.project, "repo-config"))).toBe(false);
  });

  test("cannot hide the question in a terminal or in a Kiro IDE chat", () => {
    const dotenv = () => "AIDLC_TEST_NAME=x\nAIDLC_TEST_CONFIG_DETECTION_JSON={}\n";
    const terminal = inProject(dotenv, ownSettings);
    expect(terminal.seen).toMatchObject({ path: terminal.settings, due: true, set: terminal.settings });
    const userData = (home: string) => join(home, "ud", "User", "settings.json");
    const chat = inProject(dotenv, userData, (home) => ({ VSCODE_CODE_CACHE_PATH: join(home, "ud", "CachedData", "abc") }));
    expect(chat.seen).toMatchObject({ path: chat.settings, due: true, set: chat.settings });
    expect(chat.seen.ask).toContain("Do you want me to turn Workflows off?");
  });
});

describe("the chat asks once", () => {
  const inKiro = (m: ReturnType<typeof machine>) => ({ ...m.env, VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") });

  test("a Kiro IDE chat with Workflows on asks once; a no is simply not acting, and no chat asks again", () => {
    const m = machine(ON_WITH_COMMENTS);
    withEnv(inKiro(m), () => {
      const line = kiroIdeWorkflowsAsk("bun .kiro/tools/aidlc.ts", process.env);
      expect(line).toContain("Kiro's Workflows feature is on, and it stops AI-DLC's reviews and helpers from running in this chat.");
      expect(line).toContain("Do you want me to turn Workflows off? It is a Kiro setting for all your projects");
      expect(line).toContain("run `bun .kiro/tools/aidlc.ts config trust --kiro-workflows off --yes`");
      // A first message that already asks to turn it off or on is the answer, never asked again.
      expect(line).toStartWith("ASK ONCE: if the person's message already asks to turn this Kiro's Workflows feature off or to keep it on (the Kiro skill's Workflows note says which Kiro a request means), that is their answer and you do not ask: do what it asks as that note says (keeping a switch on runs its setter with `on --yes`, so the answer is kept) and tell them what it prints. Otherwise, after you answer their message, ask them");
      expect(readKiroWorkflowsAnswer()).toBe("asked");
      expect(kiroIdeWorkflowsAsk("bun .kiro/tools/aidlc.ts", process.env)).toBe("");
    });
  });

  test("a settings file with an error is told once for each error, whatever was answered", () => {
    const m = machine(MISSING_COMMA);
    withEnv(inKiro(m), () => {
      recordKiroWorkflowsAnswer("on");
      const line = kiroIdeWorkflowsAsk("aidlc", process.env);
      expect(line).toStartWith("TELL ONCE:");
      expect(line).toContain(`Kiro's settings file (${m.settingsPath}) has an error, so AI-DLC cannot tell whether Kiro's Workflows feature is on.`);
      expect(line).toContain("While Kiro's Workflows feature is on, AI-DLC's reviews and helpers do not run in your chats.");
      expect(line).toContain("Fix the error in that file");
      expect(line).not.toContain("--kiro-workflows");
      expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toBe("");
      expect(readKiroWorkflowsAnswer()).toBe("on");
      // A file fixed, checked, and broken again in another way is told again.
      writeFileSync(m.settingsPath, `{ "${KEY}": true }\n`);
      expect(readKiroIdeWorkflows(m.env).readable).toBe(true);
      writeFileSync(m.settingsPath, `{ "${KEY}": true,, }\n`);
      expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toStartWith("TELL ONCE:");
    });
  });

  test("two Kiro settings files with errors are each told once", () => {
    const a = machine(MISSING_COMMA);
    const b = machine(MISSING_COMMA);
    const shared = { AIDLC_INSTALL_ROOT: a.env.AIDLC_INSTALL_ROOT, AIDLC_BIN_DIR: a.env.AIDLC_BIN_DIR };
    for (const m of [a, b]) {
      withEnv({ ...inKiro(m), ...shared }, () => expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toStartWith("TELL ONCE:"));
    }
    for (const m of [a, b]) {
      withEnv({ ...inKiro(m), ...shared }, () => expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toBe(""));
    }
  });

  test("never asked: the error is told first, and the question still comes once the file is fixed", () => {
    const m = machine(MISSING_COMMA);
    withEnv(inKiro(m), () => {
      expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toStartWith("TELL ONCE:");
      expect(readKiroWorkflowsAnswer()).toBeNull();
      writeFileSync(m.settingsPath, ON_WITH_COMMENTS);
      expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toContain("Do you want me to turn Workflows off?");
    });
  });

  test("no line with Workflows off, outside Kiro IDE (Kiro CLI), or once the person answered at setup", () => {
    const off = machine(`{ "${KEY}": false }`);
    withEnv(inKiro(off), () => expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toBe(""));
    const cli = machine(ON_WITH_COMMENTS);
    withEnv(cli.env, () => expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toBe(""));
    const answered = machine(ON_WITH_COMMENTS);
    withEnv(inKiro(answered), () => {
      recordKiroWorkflowsAnswer("on");
      expect(kiroIdeWorkflowsAsk("aidlc", process.env)).toBe("");
    });
  });
});

describe("config trust and doctor", () => {
  test("trust names Workflows as the one thing that needs the person, with the command that turns it off", () => {
    const m = machine(ON_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    withEnv(m.env, () => {
      const issue = trustStatus(project, ".kiro", "kiro-ide").issues.find((entry) => entry.id === "kiro-workflows-on");
      expect(issue?.message).toContain("Kiro's Workflows feature is on, so AI-DLC's reviews and helpers do not run");
      const action = postApplyOutstandingActions(project, ".kiro", "kiro-ide").find((entry) => entry.id === "kiro-workflows-on");
      expect(action?.command).toMatch(/config trust --kiro-workflows off$/);
      expect(trustStatus(project, ".kiro", "kiro").issues.some((entry) => entry.id === "kiro-workflows-on")).toBe(false);
      recordKiroWorkflowsAnswer("on");
      expect(trustStatus(project, ".kiro", "kiro-ide").issues.some((entry) => entry.id === "kiro-workflows-on")).toBe(false);
    });
  });

  // Kiro IDE 1.2.37 turned Workflows on from a file missing a comma, which
  // AI-DLC cannot read: unknown, never off, and the step is the person's.
  test("a settings file AI-DLC cannot read is named as unknown, never as off, with the person's own step", () => {
    const m = machine(MISSING_COMMA);
    const unknown = "Kiro Workflows: Kiro's settings file has an error, so AI-DLC cannot tell whether Workflows is on";
    const step = `fix the error in ${m.settingsPath}`;
    const setup = installKiroIde(m.env);
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(MISSING_COMMA);
    expect(setup.out).toContain(unknown);
    expect(setup.out).toContain(step);
    const { project } = setup;
    const show = runInit(["config", "trust", "--project-dir", project, "--show", "--json"], project, m.env);
    expect(show.status, show.out).toBe(0);
    expect(JSON.parse(show.out).data.kiroWorkflows).toEqual({ enabled: false, readable: false, settingsPath: m.settingsPath, answer: null });
    const human = runInit(["config", "trust", "--project-dir", project, "--show"], project, m.env);
    expect(human.out).toContain(`Kiro Workflows: could not be read (${m.settingsPath})`);
    expect(human.out).not.toContain("Kiro Workflows: off");
    const check = runInit(["config", "trust", "--project-dir", project, "--check"], project, m.env);
    expect(check.status, check.out).toBe(0);
    expect(check.out).toContain(unknown);
    // The trust walk says the person's step before its own review question.
    const walk = runInit(
      ["config", "trust", "--project-dir", project, "--harness", "kiro"],
      project,
      { ...m.env, AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" },
    );
    expect(walk.status, walk.out).toBe(0);
    const said = walk.out.indexOf(`${unknown}: ${step}`);
    expect(said, walk.out).toBeGreaterThan(-1);
    expect(walk.out.indexOf("Separately, record that you reviewed")).toBeGreaterThan(said);
    expect(kiroIdeWorkflowsDoctorCheck(project, ".kiro", m.env)).toMatchObject({ pass: false, severity: "warn", label: unknown });
    expect(kiroIdeWorkflowsDoctorCheck(project, ".kiro", m.env)?.fix).toContain(step);
    withEnv(m.env, () => {
      const action = postApplyOutstandingActions(project, ".kiro", "kiro-ide").find((entry) => entry.id === "kiro-workflows-unreadable");
      expect(action?.message).toBe(unknown);
      // The step is shown alone in setup's list, so it names the file.
      expect(action?.step).toContain(step);
      expect(action?.command).toMatch(/config trust --check$/);
      // Whatever the person answered before, Kiro may read the file as on.
      for (const answer of ["off", "asked", "on"] as const) {
        recordKiroWorkflowsAnswer(answer);
        expect(trustStatus(project, ".kiro", "kiro-ide").issues.some((entry) => entry.id === "kiro-workflows-unreadable"), answer)
          .toBe(true);
      }
    });
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(MISSING_COMMA);
  });

  test("doctor warns while Workflows is on and names the same command; ok when it is off", () => {
    const on = machine(ON_WITH_COMMENTS);
    const { project } = installKiroIde({ ...on.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(on.root, "none.json") });
    const row = kiroIdeWorkflowsDoctorCheck(project, ".kiro", on.env);
    expect(row).toMatchObject({ pass: false, severity: "warn" });
    expect(row?.label).toContain("Kiro Workflows is on, so AI-DLC's reviews and helpers do not run");
    expect(row?.fix).toContain("config trust --kiro-workflows off");
    expect(row?.fix).toContain("Developer: Reload Window");
    const off = machine(`{ "${KEY}": false }`);
    expect(kiroIdeWorkflowsDoctorCheck(project, ".kiro", off.env)).toEqual({ pass: true, label: "Kiro Workflows is off" });
    expect(kiroIdeWorkflowsDoctorCheck(temp("aidlc-t-kiro-workflows-empty-"), undefined, on.env)).toBeNull();
  });

  test("the doctor command shows the row", () => {
    const on = machine(ON_WITH_COMMENTS);
    const { project } = installKiroIde({ ...on.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(on.root, "none.json") });
    const doctor = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-doctor.ts"), "--project-dir", project], {
      cwd: project,
      env: childEnv(on.env),
      encoding: "utf-8",
    });
    expect(`${doctor.stdout}${doctor.stderr}`).toContain("Kiro Workflows is on, so AI-DLC's reviews and helpers do not run");
  });

  test("`config --yes` turns Workflows off, says so, and keeps the answer; without --yes it only lists the step", () => {
    const yes = machine(ON_WITH_COMMENTS);
    const first = installKiroIde(yes.env);
    expect(readFileSync(yes.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS.replace(`"${KEY}": true`, `"${KEY}": false`));
    expect(first.out).toContain("Turned Kiro's Workflows feature off, so AI-DLC's reviews and helpers run in your chats.");
    expect(first.out).toContain("You can turn it back on any time.");
    withEnv(yes.env, () => expect(readKiroWorkflowsAnswer()).toBe("off"));

    const asked = machine(ON_WITH_COMMENTS);
    const second = installKiroIde(asked.env, false);
    expect(readFileSync(asked.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS);
    expect(second.out).toContain("config trust --kiro-workflows off");
    withEnv(asked.env, () => expect(readKiroWorkflowsAnswer()).toBeNull());
  });

  test("`config trust --kiro-workflows off|on` turns it off and back on; --show --json reads it", () => {
    const m = machine(ON_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    const show = runInit(["config", "trust", "--project-dir", project, "--show", "--json"], project, m.env);
    expect(show.status, show.out).toBe(0);
    expect(JSON.parse(show.out).data.kiroWorkflows).toEqual({ enabled: true, readable: true, settingsPath: m.settingsPath, answer: null });
    const human = runInit(["config", "trust", "--project-dir", project, "--show"], project, m.env);
    expect(human.out).toContain(`Kiro Workflows: on (${m.settingsPath})`);

    const off = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "off", "--yes"], project, m.env);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("Turned Kiro's Workflows feature off");
    const offAgain = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "off", "--yes"], project, m.env);
    expect(offAgain.status, offAgain.out).toBe(0);
    expect(offAgain.out).toContain("Kiro's Workflows feature is already off; nothing changed.");
    expect(readKiroIdeWorkflows(m.env).enabled).toBe(false);
    withEnv(m.env, () => expect(readKiroWorkflowsAnswer()).toBe("off"));

    const on = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "on", "--yes"], project, m.env);
    expect(on.status, on.out).toBe(0);
    expect(on.out).toContain("Turned Kiro's Workflows feature back on");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS);
    withEnv(m.env, () => expect(readKiroWorkflowsAnswer()).toBe("on"));

    // Keeping it on when it is on changes nothing and keeps the answer, with the way to turn it off later.
    const kept = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "on", "--yes"], project, m.env);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain("Kept Kiro's Workflows feature on; AI-DLC will not ask again. To turn it off later:");
    expect(kept.out).not.toContain("Turned Kiro's Workflows feature back on");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS);
    withEnv(m.env, () => expect(readKiroWorkflowsAnswer()).toBe("on"));

    const bad = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "maybe", "--yes"], project, m.env);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("--kiro-workflows must be on or off");
  });

  test("the switch is Kiro IDE's: another harness's trust section refuses it", () => {
    const m = machine(ON_WITH_COMMENTS);
    const project = temp("aidlc-t-kiro-workflows-claude-");
    mkdirSync(join(project, ".git"));
    const install = runInit(
      ["config", "--project-dir", project, "--from", join(REPO_ROOT, "dist-release", "claude"), "--harness", "claude", "--yes"],
      project,
      m.env,
    );
    expect(install.status, install.out).toBe(0);
    const refused = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "off", "--yes"], project, m.env);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--kiro-workflows applies to Kiro IDE projects");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS);
    const cli = kiroCli(m, { "chat.enableWorkflows": true });
    const cliRefused = runInit(["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "off", "--yes"], project, { ...m.env, ...cli.env });
    expect(cliRefused.status).not.toBe(0);
    expect(cliRefused.out).toContain("--kiro-cli-workflows applies to Kiro IDE projects");
    expect(writesIn(cli.writes)).toEqual([]);
    expect(existsSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"))).toBe(false);
  });
});

describe("a Kiro IDE chat's first prompt", () => {
  test("carries the one ask line while Workflows is on, and only once on this machine", async () => {
    const m = machine(ON_WITH_COMMENTS);
    const proj = createTestProject();
    temporary.push(proj);
    const root = join(REPO_ROOT, "dist", "kiro-ide");
    cpSync(join(root, ".kiro"), join(proj, ".kiro"), { recursive: true });
    cpSync(join(root, "aidlc"), join(proj, "aidlc"), { recursive: true });
    const prompt = async (): Promise<string> => {
      const child = Bun.spawn(
        [process.execPath, join(proj, ".kiro", "tools", "aidlc.ts"), "engine", "adapter", "kiro-ide", "record-human-turn"],
        {
          cwd: proj,
          stdin: new Blob([JSON.stringify({ cwd: proj, hook_event_name: "UserPromptSubmit", session_id: `sess_${randomUUID()}`, prompt: "hello" })]),
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv({ ...m.env, VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") }),
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return stdout;
    };
    const first = await prompt();
    expect(first).toContain("Do you want me to turn Workflows off?");
    expect(first).toContain("config trust --kiro-workflows off --yes");
    expect(await prompt()).not.toContain("Workflows");
    expect(existsSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-workflows"))).toBe(true);
  });
});

// Kiro CLI's own switch, read and set through `kiro-cli settings` (here the
// Kiro session seam stands in for Kiro CLI and logs each write).
function kiroCli(m: ReturnType<typeof machine>, current: Record<string, unknown> | null, failWrite?: string) {
  const writes = join(m.root, "writes.jsonl");
  const kiroHome = join(m.root, "kiro-home");
  return {
    writes,
    settingsPath: join(kiroHome, "settings", "cli.json"),
    env: {
      AIDLC_TEST_KIRO_SESSION_JSON: JSON.stringify({ current, writes, ...(failWrite ? { failWrite } : {}) }),
      KIRO_HOME: kiroHome,
    },
  };
}

const writesIn = (path: string): string[][] =>
  existsSync(path) ? readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];

describe("Kiro CLI's own Workflows switch", () => {
  const CLI_ON = { "chat.enableWorkflows": true };

  test("trust and doctor name it with its own command, and an answer about Kiro IDE does not hide it", () => {
    const m = machine("{}\n");
    const { project } = installKiroIde(m.env);
    const cli = kiroCli(m, CLI_ON);
    const env = { ...m.env, ...cli.env };
    withEnv(env, () => {
      recordKiroWorkflowsAnswer("on");
      const issue = trustStatus(project, ".kiro", "kiro-ide").issues.find((entry) => entry.id === "kiro-cli-workflows-on");
      expect(issue?.message).toContain("Kiro CLI's Workflows feature is on, so AI-DLC's reviews and helpers do not run in your Kiro CLI chats");
      const action = postApplyOutstandingActions(project, ".kiro", "kiro-ide").find((entry) => entry.id === "kiro-cli-workflows-on");
      expect(action?.command).toMatch(/config trust --kiro-cli-workflows off$/);
    });
    const doctor = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-doctor.ts"), "--project-dir", project], {
      cwd: project,
      env: childEnv(env),
      encoding: "utf-8",
    });
    const said = `${doctor.stdout}${doctor.stderr}`;
    expect(said).toContain("Kiro CLI Workflows is on, so AI-DLC's reviews and helpers do not run in your Kiro CLI chats");
    expect(said).toContain("config trust --kiro-cli-workflows off");
    const show = runInit(["config", "trust", "--project-dir", project, "--show", "--json"], project, env);
    expect(show.status, show.out).toBe(0);
    const data = JSON.parse(show.out).data;
    expect(data.kiroCliWorkflows).toEqual({ enabled: true, settingsPath: cli.settingsPath, answer: null });
    expect(data.kiroWorkflows).toEqual({ enabled: false, readable: true, settingsPath: m.settingsPath, answer: "on" });
    const human = runInit(["config", "trust", "--project-dir", project, "--show"], project, env);
    expect(human.out).toContain(`Kiro CLI Workflows: on (${cli.settingsPath})`);
    // Off, or no Kiro CLI answering here: nothing to name.
    withEnv({ ...m.env, ...kiroCli(m, {}).env }, () => {
      expect(trustStatus(project, ".kiro", "kiro-ide").issues.some((entry) => entry.id === "kiro-cli-workflows-on")).toBe(false);
    });
    withEnv({ ...m.env, ...kiroCli(m, null).env }, () => {
      expect(trustStatus(project, ".kiro", "kiro-ide").kiroCliWorkflows).toBeUndefined();
    });
  });

  test("`config --yes` turns it off through Kiro CLI and keeps its own answer; Kiro IDE's is left alone", () => {
    const m = machine("{}\n");
    const cli = kiroCli(m, CLI_ON);
    const setup = installKiroIde({ ...m.env, ...cli.env });
    expect(writesIn(cli.writes)).toContainEqual(["settings", "chat.enableWorkflows", "false"]);
    expect(setup.out).toContain("Turned Kiro CLI's Workflows feature off, so AI-DLC's reviews and helpers run in your Kiro CLI chats.");
    expect(setup.out).toContain("Quit Kiro CLI and start `kiro-cli --v3` again");
    expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "utf-8")).toBe("off\n");
    expect(existsSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-workflows"))).toBe(false);
    expect(readFileSync(m.settingsPath, "utf-8")).toBe("{}\n");
  });

  test("`config trust --kiro-cli-workflows on|off` sets it through Kiro CLI, and says so when Kiro CLI does not save it", () => {
    const m = machine("{}\n");
    const { project } = installKiroIde(m.env);
    const off = kiroCli(m, { "chat.enableWorkflows": false });
    const on = runInit(["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "on", "--yes"], project, { ...m.env, ...off.env });
    expect(on.status, on.out).toBe(0);
    expect(on.out).toContain("Turned Kiro CLI's Workflows feature back on");
    expect(writesIn(off.writes)).toEqual([["settings", "chat.enableWorkflows", "true"]]);
    expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "utf-8")).toBe("on\n");

    const keep = kiroCli(m, CLI_ON);
    const keptWrites = writesIn(keep.writes);
    const kept = runInit(["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "on", "--yes"], project, { ...m.env, ...keep.env });
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain("Kept Kiro CLI's Workflows feature on; AI-DLC will not ask again. To turn it off later:");
    expect(kept.out).not.toContain("Turned Kiro CLI's Workflows feature back on");
    expect(writesIn(keep.writes)).toEqual(keptWrites);
    expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "utf-8")).toBe("on\n");

    const alreadyOff = kiroCli(m, { "chat.enableWorkflows": false });
    const offAgain = runInit(["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "off", "--yes"], project, { ...m.env, ...alreadyOff.env });
    expect(offAgain.status, offAgain.out).toBe(0);
    expect(offAgain.out).toContain("Kiro CLI's Workflows feature is already off; nothing changed.");
    expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "utf-8")).toBe("off\n");

    // A write Kiro CLI refuses keeps whatever answer was there.
    writeFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "on\n");
    const refused = kiroCli(m, CLI_ON, "chat.enableWorkflows");
    const failed = runInit(["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "off", "--yes"], project, { ...m.env, ...refused.env });
    expect(failed.status).not.toBe(0);
    expect(failed.out).toContain("In Kiro CLI, open /settings and turn Workflows off instead.");
    expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "utf-8")).toBe("on\n");

    const combined = kiroCli(m, CLI_ON);
    const before = writesIn(combined.writes);
    const both = runInit(
      ["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "off", "--kiro-terminal", "powershell", "--yes"],
      project,
      { ...m.env, ...combined.env },
    );
    expect(both.status).not.toBe(0);
    expect(both.out).toContain("--kiro-cli-workflows cannot be combined with --kiro-terminal");
    expect(writesIn(combined.writes)).toEqual(before);

    const none = runInit(["config", "trust", "--project-dir", project, "--kiro-cli-workflows", "off", "--yes"], project, m.env);
    expect(none.status).not.toBe(0);
    expect(none.out).toContain("Kiro CLI did not answer here");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe("{}\n");
  });

  test("a trust walk preview (--dry-run) asks neither Workflows question and changes no Kiro setting", () => {
    const m = machine(ON_WITH_COMMENTS);
    const { project } = installKiroIde({ ...m.env, AIDLC_TEST_KIRO_IDE_SETTINGS: join(m.root, "none.json") });
    const cli = kiroCli(m, CLI_ON);
    const walk = runInit(
      ["config", "trust", "--project-dir", project, "--harness", "kiro", "--dry-run"],
      project,
      { ...m.env, ...cli.env, AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "y\ny\ny\nn\n" },
    );
    expect(walk.status, walk.out).toBe(0);
    expect(walk.out).not.toContain("Turn Workflows off?");
    expect(walk.out).not.toContain("Turn it off?");
    expect(readFileSync(m.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS);
    expect(writesIn(cli.writes)).toEqual([]);
    expect(existsSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-workflows"))).toBe(false);
    expect(existsSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"))).toBe(false);
  });

  test("a Kiro CLI chat's first prompt asks once about Kiro CLI's switch; a Kiro IDE chat does not", async () => {
    const m = machine("{}\n");
    const cli = kiroCli(m, CLI_ON);
    const proj = createTestProject();
    temporary.push(proj);
    const root = join(REPO_ROOT, "dist", "kiro-ide");
    cpSync(join(root, ".kiro"), join(proj, ".kiro"), { recursive: true });
    cpSync(join(root, "aidlc"), join(proj, "aidlc"), { recursive: true });
    const prompt = async (extra: Record<string, string>): Promise<string> => {
      const child = Bun.spawn(
        [process.execPath, join(proj, ".kiro", "tools", "aidlc.ts"), "engine", "adapter", "kiro-ide", "record-human-turn"],
        {
          cwd: proj,
          stdin: new Blob([JSON.stringify({ cwd: proj, hook_event_name: "UserPromptSubmit", session_id: `sess_${randomUUID()}`, prompt: "hello" })]),
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv({ ...m.env, ...cli.env, ...extra }),
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return stdout;
    };
    expect(await prompt({ VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") })).not.toContain("Workflows");
    const first = await prompt({});
    expect(first).toContain("Kiro CLI's Workflows feature is on, and it stops AI-DLC's reviews and helpers from running in this chat.");
    expect(first).toContain("config trust --kiro-cli-workflows off --yes");
    expect(first).toContain("ASK ONCE: if the person's message already asks to turn this Kiro's Workflows feature off or to keep it on (the Kiro skill's Workflows note says which Kiro a request means), that is their answer and you do not ask: do what it asks as that note says (keeping a switch on runs its setter with `on --yes`, so the answer is kept) and tell them what it prints. Otherwise, after you answer their message, ask them");
    expect(await prompt({})).not.toContain("Workflows");
    expect(readFileSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-cli-workflows"), "utf-8")).toBe("asked\n");
    expect(existsSync(join(m.env.AIDLC_INSTALL_ROOT, "kiro-ide-workflows"))).toBe(false);
  });
});
