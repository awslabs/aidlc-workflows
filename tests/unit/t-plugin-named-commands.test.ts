// covers: function:pluginCommandTable function:readPluginCommands function:pluginScriptLaunch
//
// A plugin names its commands in its manifest (`aidlc.commands`, each name a
// script in its tools/), and a person runs one like AI-DLC's own: `aidlc <name>`
// at a terminal, `/aidlc <name>` in the chat (#3415). Only an installed plugin
// that is on runs; a name AI-DLC or another plugin already has is skipped, and
// the sync says so once; `aidlc --help` lists the commands under their plugin.
// The fixture is test-pro with one command, built as a real projection and
// synced the way a session start does (`aidlc-plugin.ts sync` with the host's
// plugin root), on a copy install. t-native-plugin-command.test.ts runs the
// same command under the compiled engine.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_COMMAND_WORDS } from "../../core/tools/aidlc-command.ts";
import { pluginCommandTable } from "../../core/tools/aidlc-plugin-commands.ts";
import { readPluginCommands, validatePluginRoot } from "../../core/tools/aidlc-plugin-validate.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const COMMAND = "test-pro-hello";

// The command's script: what it was given, and the exit code it was told to use.
const HELLO_SCRIPT = `import { spawnSync } from "node:child_process";
const seen: Record<string, unknown> = {
  argv: process.argv.slice(2),
  plugin: process.env.AIDLC_PLUGIN_NAME ?? null,
  project: process.env.AIDLC_PROJECT_DIR ?? null,
  harness: process.env.AIDLC_HARNESS_DIR ?? null,
  beBun: process.env.BUN_BE_BUN ?? null,
  cwd: process.cwd(),
};
if (process.env.HELLO_ENGINE) {
  const engine = spawnSync(process.env.HELLO_ENGINE, ["version"], { encoding: "utf-8" });
  seen.engine = (engine.stdout ?? "").trim();
}
if (process.env.HELLO_MARK) await Bun.write(process.env.HELLO_MARK, "ran\\n");
process.stdout.write(JSON.stringify(seen) + "\\n");
process.exit(Number(process.env.HELLO_EXIT ?? "0"));
`;

let root = "";

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:AIDLC_|CLAUDE_|CODEX_|KIRO_|CURSOR_|COPILOT_|BUN_BE_BUN$|HELLO_)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, NO_COLOR: "1", ...extra };
}

type Manifest = Record<string, unknown> & { aidlc: Record<string, unknown> };

// test-pro with one command, its manifest edited by `edit`.
function writePlugin(dir: string, edit: (manifest: Manifest) => void = () => {}): string {
  mkdirSync(join(dir, ".."), { recursive: true });
  cpSync(join(REPO_ROOT, "plugins", "test-pro"), dir, { recursive: true });
  rmSync(join(dir, "tests"), { recursive: true, force: true });
  writeFileSync(join(dir, "tools", `${COMMAND}.ts`), HELLO_SCRIPT);
  const path = join(dir, ".aidlc-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as Manifest;
  manifest.aidlc.commands = {
    [COMMAND]: { script: `tools/${COMMAND}.ts`, description: "Say hello from test-pro" },
  };
  edit(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function build(source: string, out: string): string {
  const built = spawnSync(BUN, [join(DIST_TOOLS, "aidlc-plugin-build.ts"), source, "claude", out], {
    encoding: "utf-8",
    env: cleanEnv(),
  });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  return out;
}

function project(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO_ROOT, "dist", "claude"), dir, { recursive: true });
  return dir;
}

function sync(projectDir: string, pluginRoot: string): { status: number | null; out: string } {
  const run = spawnSync(BUN, [join(projectDir, ".claude", "tools", "aidlc-plugin.ts"), "sync"], {
    cwd: projectDir,
    encoding: "utf-8",
    env: cleanEnv({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: projectDir,
      AIDLC_HARNESS_DIR: ".claude",
      AIDLC_HARNESS_NAME: "claude",
    }),
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

function aidlc(projectDir: string, args: string[], extra: NodeJS.ProcessEnv = {}, cwd = projectDir) {
  const run = spawnSync(BUN, [join(projectDir, ".claude", "tools", "aidlc.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    env: cleanEnv(extra),
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function setPlugins(projectDir: string, plugins: string[] | null): void {
  const path = join(projectDir, ".claude", "tools", "data", "harness.json");
  const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  if (plugins === null) delete data.plugins;
  else data.plugins = plugins;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// In the project's own tools tree, so its data and harness are the ones read.
function inProject(projectDir: string, code: string): unknown {
  const run = spawnSync(BUN, ["-e", code], {
    cwd: projectDir,
    encoding: "utf-8",
    env: cleanEnv({ AIDLC_PROJECT_DIR: projectDir }),
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "null");
}

let builtRoot = "";
let main = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aidlc-pnc-"));
  builtRoot = build(writePlugin(join(root, "src", "test-pro")), join(root, "built", "test-pro"));
  main = project("main");
  const synced = sync(main, builtRoot);
  expect(synced.status, synced.out).toBe(0);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a plugin's manifest names its commands", () => {
  test("validate: a commands entry passes; a bad name, a core word, a script outside tools/, a missing script, no contributes.tools and an unknown key are manifest-commands findings", () => {
    const good = writePlugin(join(root, "validate-good", "test-pro"));
    expect(validatePluginRoot(good).errors.filter((finding) => finding.rule === "manifest-commands")).toEqual([]);

    const cases: Array<[string, (manifest: Manifest) => void, RegExp]> = [
      ["name", (m) => { m.aidlc.commands = { "Hello World": { script: `tools/${COMMAND}.ts`, description: "x" } }; }, /Hello World/],
      ["core", (m) => { m.aidlc.commands = { doctor: { script: `tools/${COMMAND}.ts`, description: "x" } }; }, /AI-DLC's own/],
      ["outside", (m) => { m.aidlc.commands = { [COMMAND]: { script: "hooks/compose.ts", description: "x" } }; }, /tools\//],
      ["missing", (m) => { m.aidlc.commands = { [COMMAND]: { script: "tools/nothing-here.ts", description: "x" } }; }, /nothing-here/],
      ["no-tools", (m) => { delete (m.aidlc.contributes as Record<string, unknown>).tools; }, /contributes\.tools/],
      ["unknown-key", (m) => { m.aidlc.commands = { [COMMAND]: { script: `tools/${COMMAND}.ts`, description: "x", shell: true } }; }, /shell/],
      ["no-description", (m) => { m.aidlc.commands = { [COMMAND]: { script: `tools/${COMMAND}.ts` } }; }, /description/],
    ];
    for (const [label, edit, said] of cases) {
      const dir = writePlugin(join(root, `validate-${label}`, "test-pro"), edit);
      const findings = validatePluginRoot(dir).errors.filter((finding) => finding.rule === "manifest-commands");
      expect(findings.length, label).toBeGreaterThan(0);
      expect(findings.map((finding) => finding.message).join("\n"), label).toMatch(said);
    }
  });

  test("the one parser keeps the well-formed entries, a core word's included, and reports the rest", () => {
    const read = readPluginCommands({
      commands: {
        [COMMAND]: { script: `tools/${COMMAND}.ts`, description: "Say hello" },
        "Bad Name": { script: "tools/x.ts", description: "x" },
        config: { script: "tools/y.ts", description: "y" },
      },
    });
    expect(Object.keys(read.commands)).toEqual(["config", COMMAND]);
    expect(read.issues.map((issue) => issue.name)).toEqual(["Bad Name", "config"]);
    expect(readPluginCommands({}).commands).toEqual({});
  });

  test("every public route verb and noun and the chat's own leading words are core command words", async () => {
    const { ROUTES } = await import("../../core/tools/aidlc.ts");
    const { ORCHESTRATOR_VERBS, WORKSPACE_VERBS } = await import("../../core/tools/aidlc-lib.ts");
    for (const route of ROUTES) {
      if (route.namespace !== "public") continue;
      for (const word of route.group === "top" ? route.verbs : [route.group]) {
        if (word.startsWith("-")) continue;
        expect(CORE_COMMAND_WORDS.has(word), word).toBe(true);
      }
    }
    for (const word of [...WORKSPACE_VERBS, ...ORCHESTRATOR_VERBS, "engine", "system", "knowledge", "plugin", "unit", "compose", "config", "help"]) {
      expect(CORE_COMMAND_WORDS.has(word), word).toBe(true);
    }
  });
});

describe("the command table", () => {
  function dataDir(name: string, stamps: Record<string, Record<string, unknown>>): string {
    const dir = join(root, "table", name);
    mkdirSync(dir, { recursive: true });
    for (const [key, commands] of Object.entries(stamps)) {
      writeFileSync(join(dir, `plugin-compose-${key}.json`), JSON.stringify({
        schemaVersion: 1, name: key, version: "1.0.0", sourceHash: "sha256:0", commands,
      }));
    }
    return dir;
  }
  const entry = (script: string) => ({ script, description: script });

  test("an enabled plugin's command, an off plugin's is off, a core word and a second plugin's same name are skipped naming who has it, first by name wins", () => {
    const dir = dataDir("mixed", {
      zeta: { weekly: entry("tools/zeta-weekly.ts"), doctor: entry("tools/zeta-doctor-cmd.ts"), classic: entry("tools/zeta-classic.ts") },
      alpha: { weekly: entry("tools/alpha-weekly.ts"), hello: entry("tools/alpha-hello.ts") },
      gamma: { gamma: entry("tools/gamma.ts") },
    });
    const table = pluginCommandTable(dir, new Set(["aidlc", "alpha", "zeta"]), new Set(["classic"]));
    expect([...table.commands.keys()].sort()).toEqual(["hello", "weekly"]);
    expect(table.commands.get("weekly")?.plugin).toBe("alpha");
    expect(table.off.get("gamma")).toBe("gamma");
    expect(table.skipped).toEqual([
      { plugin: "zeta", name: "classic", by: { kind: "plan", name: "classic" } },
      { plugin: "zeta", name: "doctor", by: { kind: "core" } },
      { plugin: "zeta", name: "weekly", by: { kind: "plugin", plugin: "alpha" } },
    ]);
  });

  test("no selection: every composed plugin is on", () => {
    const dir = dataDir("all-on", { alpha: { hello: entry("tools/alpha-hello.ts") } });
    expect([...pluginCommandTable(dir, null, new Set()).commands.keys()]).toEqual(["hello"]);
  });
});

describe("aidlc <name> on a copy install", () => {
  test("aidlc test-pro-hello runs the script with its args, --json and --project-dir after the name included, and passes its exit code", () => {
    const stamp = JSON.parse(readFileSync(join(main, ".claude", "tools", "data", "plugin-compose-test-pro.json"), "utf-8"));
    expect(stamp.commands).toEqual({ [COMMAND]: { script: `tools/${COMMAND}.ts`, description: "Say hello from test-pro" } });

    const run = aidlc(main, [COMMAND, "a", "b c", "--json", "--project-dir", "elsewhere"], { HELLO_EXIT: "3" });
    expect(run.status, run.stderr).toBe(3);
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.argv).toEqual(["a", "b c", "--json", "--project-dir", "elsewhere"]);
    expect(seen.plugin).toBe("test-pro");
    expect(seen.harness).toBe(".claude");
    expect(seen.beBun).toBeNull();
    expect(realpathSync(seen.project)).toBe(realpathSync(main));
    // Forms of ours that we would refuse are the script's words after the name.
    const own = aidlc(main, [COMMAND, "--project-dir=x", "--project-dir"]);
    expect(own.status, own.stderr).toBe(0);
    expect(JSON.parse(own.stdout.trim()).argv).toEqual(["--project-dir=x", "--project-dir"]);
  });

  test("our own --project-dir before the name names the project, and the script runs where the person is", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const run = aidlc(main, ["--project-dir", main, COMMAND], {}, elsewhere);
    expect(run.status, run.stderr).toBe(0);
    const seen = JSON.parse(run.stdout.trim());
    expect(realpathSync(seen.project)).toBe(realpathSync(main));
    expect(realpathSync(seen.cwd)).toBe(realpathSync(elsewhere));
  });

  test("a plugin that is off: its command does not run and says it is off in one line", () => {
    const off = project("off");
    expect(sync(off, builtRoot).status).toBe(0);
    setPlugins(off, ["aidlc"]);
    const mark = join(root, "off-mark");
    const run = aidlc(off, [COMMAND], { HELLO_MARK: mark });
    expect(run.status).toBe(1);
    expect(existsSync(mark)).toBe(false);
    const lines = run.stderr.trim().split("\n");
    expect(lines.length, run.stderr).toBe(1);
    expect(lines[0]).toContain(`'${COMMAND}' is a command of the test-pro plugin, which is off in this project`);
    expect(lines[0]).toContain("--plugins aidlc,test-pro");
  });

  test("an unknown word is still the unknown-command error", () => {
    const run = aidlc(main, ["no-such-command"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown command 'no-such-command'");
  });

  test("a clash with a core command: the sync says it once, a second sync is silent, aidlc doctor still runs doctor", () => {
    const source = writePlugin(join(root, "src-clash", "test-pro"), (manifest) => {
      manifest.aidlc.commands = {
        [COMMAND]: { script: `tools/${COMMAND}.ts`, description: "Say hello from test-pro" },
      };
    });
    // validate refuses a core word, so the clash is written into the built copy, as an older build would carry it.
    const built = build(source, join(root, "built-clash", "test-pro"));
    const manifestPath = join(built, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    manifest.aidlc.commands = {
      ...(manifest.aidlc.commands as Record<string, unknown>),
      doctor: { script: `tools/${COMMAND}.ts`, description: "Not AI-DLC's doctor" },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const clash = project("clash");
    const first = sync(clash, built);
    expect(first.status, first.out).toBe(0);
    const said = first.out.split("\n").filter((line) => line.includes("'doctor'"));
    expect(said).toEqual(["test-pro's command 'doctor' is not added: AI-DLC's own doctor command has that name."]);
    // A change that makes the sync compose again says nothing new about it.
    writeFileSync(join(built, "tools", `${COMMAND}.ts`), `${HELLO_SCRIPT}\n// v2\n`);
    const second = sync(clash, built);
    expect(second.status, second.out).toBe(0);
    expect(second.out).not.toContain("'doctor'");
    const doctor = aidlc(clash, ["doctor", "--verbose"], { HELLO_MARK: join(root, "clash-mark") });
    expect(existsSync(join(root, "clash-mark"))).toBe(false);
    expect(doctor.stdout + doctor.stderr).toContain("Plugin check (test-pro)");
    expect(doctor.stdout).toContain("Plugin command: test-pro's command 'doctor' is not added: AI-DLC's own doctor command has that name.");
  });

  test("aidlc --help in the project lists the command under its plugin; outside a project help is unchanged", () => {
    const help = aidlc(main, ["--help"]);
    expect(help.status).toBe(0);
    const lines = help.stdout.split("\n");
    const at = lines.indexOf("PLUGIN COMMANDS");
    expect(at, help.stdout).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe("  test-pro");
    expect(lines[at + 2]).toMatch(new RegExp(`^ {4}${COMMAND} +Say hello from test-pro$`));
    // A project without plugin commands: the help it had.
    const plain = spawnSync(BUN, [join(DIST_TOOLS, "aidlc.ts"), "--help"], { cwd: root, encoding: "utf-8", env: cleanEnv() });
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain("PLUGIN COMMANDS");
  });
});

describe("/aidlc <name> in the chat", () => {
  test("/aidlc test-pro-hello names the command and stops; with a sentence after the name it is a reading step; the seams agree", () => {
    const exact = aidlc(main, ["engine", "orchestrate", "next", COMMAND, "--since", "7d"]);
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout).toContain(`Run \`bun .claude/tools/aidlc.ts ${COMMAND} --since 7d\``);
    expect(exact.stdout).not.toContain("--depth");

    // The reading step, as any reading step, waits behind the hooks-off step in
    // a folder no chat ran yet; the fixture switch stands in for a chat's hooks.
    const sentence = aidlc(main, ["engine", "orchestrate", "next", COMMAND, "for", "the", "sales", "team"], {
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    });
    expect(sentence.status, sentence.stderr).toBe(0);
    expect(sentence.stdout).toContain(`\`${COMMAND}\` is the name of the test-pro plugin's command`);

    const seams = inProject(main, `
      const lib = await import("./.claude/tools/aidlc-lib.ts");
      console.log(JSON.stringify({
        exact: lib.readNextLine(["${COMMAND}"]).kind,
        oneArg: lib.readNextLine(["${COMMAND} for the sales team"]).kind,
        readOnly: lib.isReadOnlyNextArgv(["${COMMAND}"]),
        terminal: lib.classifyTerminalCommand(["${COMMAND}"]),
      }));
    `);
    expect(seams).toEqual({ exact: "exact", oneArg: "command", readOnly: true, terminal: null });
  });

  test("/aidlc with the plugin off names the command, so the person sees the off line", () => {
    const off = project("chat-off");
    expect(sync(off, builtRoot).status).toBe(0);
    setPlugins(off, ["aidlc"]);
    const next = aidlc(off, ["engine", "orchestrate", "next", COMMAND]);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toContain(`Run \`bun .claude/tools/aidlc.ts ${COMMAND}\``);
  });
});

describe("an older install", () => {
  test("a project composed before commands existed records them at its next sync", () => {
    const older = project("older");
    expect(sync(older, builtRoot).status).toBe(0);
    const stampPath = join(older, ".claude", "tools", "data", "plugin-compose-test-pro.json");
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as Record<string, unknown>;
    delete stamp.commands;
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    expect(aidlc(older, [COMMAND]).status).toBe(2);
    expect(sync(older, builtRoot).status).toBe(0);
    const run = aidlc(older, [COMMAND]);
    expect(run.status, run.stderr).toBe(0);
  });
});
