// Kiro IDE's Workflows feature takes the sub-agent tool away from a chat and
// hands AI-DLC's reviews and helpers to background workflows (measured on Kiro
// IDE 1.2.37). Its switch, `kiroAgent.workflows.enabled`, lives only in Kiro's
// user settings, so it covers every project: AI-DLC turns it off when the person
// says yes (setup, `config --yes`, a chat), keeps their answer once per machine,
// and never touches any other byte of their settings file.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "AIDLC_TEST_KIRO_IDE_SETTINGS", "AIDLC_TEST_CONFIG_DETECTION_JSON",
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
    ["config", "--project-dir", project, "--from", DIST_RELEASE, "--harness", "kiro-ide", ...(yes ? ["--yes"] : [])],
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

describe("the chat asks once", () => {
  const inKiro = (m: ReturnType<typeof machine>) => ({ ...m.env, VSCODE_CODE_CACHE_PATH: join(m.root, "ud", "CachedData", "abc") });

  test("a Kiro IDE chat with Workflows on asks once; a no is simply not acting, and no chat asks again", () => {
    const m = machine(ON_WITH_COMMENTS);
    withEnv(inKiro(m), () => {
      const line = kiroIdeWorkflowsAsk("bun .kiro/tools/aidlc.ts", process.env);
      expect(line).toContain("Kiro's Workflows feature is on, and it stops AI-DLC's reviews and helpers from running in this chat.");
      expect(line).toContain("Do you want me to turn Workflows off? It is a Kiro setting for all your projects");
      expect(line).toContain("run `bun .kiro/tools/aidlc.ts config trust --kiro-workflows off --yes`");
      expect(readKiroWorkflowsAnswer()).toBe("asked");
      expect(kiroIdeWorkflowsAsk("bun .kiro/tools/aidlc.ts", process.env)).toBe("");
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

  test("doctor warns while Workflows is on and names the same command; ok when it is off", () => {
    const on = machine(ON_WITH_COMMENTS);
    withEnv(on.env, () => {
      const row = kiroIdeWorkflowsDoctorCheck(REPO_ROOT, ".kiro", "kiro-ide");
      expect(row).toMatchObject({ pass: false, severity: "warn" });
      expect(row?.label).toContain("Kiro Workflows is on");
      expect(row?.fix).toContain("config trust --kiro-workflows off");
      expect(kiroIdeWorkflowsDoctorCheck(REPO_ROOT, ".kiro", "claude")).toBeNull();
    });
    const off = machine(`{ "${KEY}": false }`);
    withEnv(off.env, () => {
      expect(kiroIdeWorkflowsDoctorCheck(REPO_ROOT, ".kiro", "kiro-ide")).toMatchObject({ pass: true, label: "Kiro Workflows is off" });
    });
  });

  test("`config --yes` turns Workflows off, says so, and keeps the answer; without --yes it only lists the step", () => {
    const yes = machine(ON_WITH_COMMENTS);
    const first = installKiroIde(yes.env);
    expect(readFileSync(yes.settingsPath, "utf-8")).toBe(ON_WITH_COMMENTS.replace(`"${KEY}": true`, `"${KEY}": false`));
    expect(first.out).toContain("Turned Kiro's Workflows feature off, so AI-DLC's reviews and helpers run in your chats.");
    expect(first.out).toContain("--kiro-workflows on");
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
    expect(JSON.parse(show.out).data.kiroWorkflows).toEqual({ enabled: true, settingsPath: m.settingsPath, answer: null });
    const human = runInit(["config", "trust", "--project-dir", project, "--show"], project, m.env);
    expect(human.out).toContain(`Kiro Workflows: on (${m.settingsPath})`);

    const off = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "off", "--yes"], project, m.env);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("Turned Kiro's Workflows feature off");
    expect(readKiroIdeWorkflows(m.env).enabled).toBe(false);
    withEnv(m.env, () => expect(readKiroWorkflowsAnswer()).toBe("off"));

    const on = runInit(["config", "trust", "--project-dir", project, "--kiro-workflows", "on", "--yes"], project, m.env);
    expect(on.status, on.out).toBe(0);
    expect(on.out).toContain("Turned Kiro's Workflows feature back on");
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
