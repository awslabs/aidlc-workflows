// covers: tool:aidlc, function:copyChannelDispatcherCommands, function:renderAllHelp, function:renderNamespaceHelp, tool:aidlc-machine-config, tool:aidlc-plugin, tool:aidlc-runner-gen, subcommand:aidlc-utility:plugin-validate, subcommand:aidlc-utility:plugin-build, subcommand:aidlc-orchestrate:next
//
// A usage line, a help pointer or a next step the dispatcher, a runner or a
// plugin verb prints is a command that runs as printed on the install it came
// from: on a copy install that is `bun <harness>/tools/aidlc.ts`, never a bare
// `aidlc`; on Codex the entry is `$aidlc`; a step names a command that exists;
// and a plugin author's verb shows the verb's own usage. Plugin sync with no
// host plugin list and nothing composed has nothing to sync.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyChannelDispatcherCommands,
  ENGINE_NAMESPACE_HELP,
  renderAllHelp,
  renderNamespaceHelp,
  resolveAction,
  SYSTEM_NAMESPACE_HELP,
} from "../../dist/claude/.claude/tools/aidlc.ts";
import { cleanupTestProject, createOrchestrationTestProject, REPO_ROOT, runOrchestrateNext } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const INVOKE = "bun .claude/tools/aidlc.ts";
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function dispatch(args: string[], cwd = join(REPO_ROOT, "dist", "claude"), env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(BUN, [join(TOOLS, "aidlc.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_INSTALL_ROOT: temp("aidlc-printed-dispatch-machine-"), ...env },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("the dispatcher's own lines name the install's command", () => {
  test("every command a copy install pre-approves is one the dispatcher runs", () => {
    for (const command of copyChannelDispatcherCommands()) {
      const action = resolveAction(command.split(" "));
      expect(action.type === "error" ? `${command}: ${action.message}` : "", command).toBe("");
    }
  });

  test("an unknown verb or command points at help the install can run", () => {
    const verb = resolveAction(["engine", "state", "frob"]);
    expect(verb.type).toBe("error");
    expect(verb.type === "error" ? verb.message : "").toContain(`try '${INVOKE} engine --help'`);
    const top = resolveAction(["frobnicate"]);
    expect(top.type === "error" ? top.message : "").toContain(`try '${INVOKE} --help'`);
    const all = renderAllHelp();
    expect(all).toContain(`Run: ${INVOKE} engine --help`);
    expect(all).toContain(`Run: ${INVOKE} system --help`);
    expect(renderNamespaceHelp(ENGINE_NAMESPACE_HELP)).toStartWith(`${INVOKE} engine <noun> <verb> [args]`);
    expect(renderNamespaceHelp(SYSTEM_NAMESPACE_HELP)).toStartWith(`${INVOKE} system <noun> <verb> [args]`);
    const config = dispatch(["engine", "config", "--help"]);
    expect(`${config.stdout}${config.stderr}`).toContain(`${INVOKE} engine config <verb> [args]`);
  });

  test("a workspace verb with no name gives its usage as the dispatcher runs it", () => {
    const action = resolveAction(["engine", "intent", "switch"]);
    expect(action.type === "error" ? action.message : "").toBe(`Usage: ${INVOKE} engine intent switch <name>\n`);
  });

  test("the machine settings usage names the command that holds them", () => {
    for (const args of [["system", "config", "global"], ["system", "config", "global", "frob"]]) {
      const res = dispatch(args);
      expect(`${res.stdout}${res.stderr}`, args.join(" ")).toContain(`usage: ${INVOKE} system config global <get|set|clear|list>`);
    }
  });

  // A step the engine names through aidlcDispatcherInvocation("<noun> <verb> ...")
  // names a noun the dispatcher has, and a verb that noun lists.
  test("every engine command the tools name in a step exists", () => {
    const missing: string[] = [];
    for (const file of readdirSync(TOOLS).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(TOOLS, file), "utf-8");
      for (const match of source.matchAll(/aidlcDispatcherInvocation\(\s*["'`]([a-z][a-z- ]*)/g)) {
        // The words written out, before a value the line fills in.
        const [noun, verb] = match[1].trim().split(/\s+/);
        const help = resolveAction(["engine", noun, "--help"]);
        if (help.type === "error" && /unknown command or noun/.test(help.message)) missing.push(`${file}: ${noun}`);
        const verbs = help.type === "noun-help" ? /^verbs: (.*)$/m.exec(help.message)?.[1].split(", ") : undefined;
        if (verb && verbs && !verbs.includes(verb)) missing.push(`${file}: ${noun} ${verb}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("a chat command with no name gives its usage in the person's own entry", () => {
  test("intent switch with no name", () => {
    const proj = createOrchestrationTestProject();
    try {
      const res = runOrchestrateNext(join(TOOLS, "aidlc-orchestrate.ts"), proj, ["intent", "switch"]);
      expect(JSON.stringify(res.directive)).toContain("Usage: /aidlc intent switch <name>");
    } finally {
      cleanupTestProject(proj);
    }
  });
});

describe("Codex's stage and compose runners name its entry", () => {
  test("no `/aidlc` command in a Codex runner", () => {
    const skills = join(REPO_ROOT, "dist", "codex", ".agents", "skills");
    const stage = readFileSync(join(skills, "aidlc-code-generation", "SKILL.md"), "utf-8");
    expect(stage).toContain("`$aidlc --stage code-generation --single`");
    const compose = readFileSync(join(skills, "aidlc-compose", "SKILL.md"), "utf-8");
    expect(compose).toContain("`$aidlc compose`");
    for (const text of [stage, compose]) expect(text).not.toMatch(/`\/aidlc[ `]/);
  });
});

describe("a plugin author's verb shows its own usage", () => {
  test("help and a bad flag name the verb as typed", () => {
    const validate = dispatch(["plugin", "validate", "--help"]);
    expect(validate.stdout).toStartWith(`Usage: ${INVOKE} plugin validate [path] [--with <base-root>]`);
    const build = dispatch(["plugin", "build", "--help"]);
    expect(build.stdout).toStartWith(`Usage: ${INVOKE} plugin build <harness> [outDir] [--plugin-root <path>]`);
    const bad = dispatch(["plugin", "validate", "--bogus"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toStartWith(`Usage: ${INVOKE} plugin validate [path] [--with <base-root>]`);
    expect(bad.stderr).toContain('unknown option "--bogus"');
    const badBuild = dispatch(["plugin", "build", "--bogus"]);
    expect(badBuild.status).toBe(2);
    expect(badBuild.stderr).toContain('unknown option "--bogus"');
  });
});

describe("plugin sync on a host with no plugin list yet", () => {
  // A project with Claude Code's tree, and a Claude Code home that has never
  // had a plugin installed (no installed_plugins.json).
  function project(): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = temp("aidlc-printed-sync-");
    mkdirSync(join(dir, ".git"));
    cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(dir, ".claude"), { recursive: true });
    return {
      dir,
      env: { CLAUDE_CONFIG_DIR: temp("aidlc-printed-sync-home-"), CLAUDE_PLUGIN_ROOT: "", PLUGIN_ROOT: "", AIDLC_PLUGIN_ROOT: "" },
    };
  }
  function sync(dir: string, env: NodeJS.ProcessEnv) {
    const res = spawnSync(BUN, [join(dir, ".claude", "tools", "aidlc-plugin.ts"), "sync"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  test("with nothing composed, there is nothing to sync", () => {
    const { dir, env } = project();
    const res = sync(dir, env);
    expect(res.out.trim()).toBe("no installed plugins; nothing to sync");
    expect(res.status).toBe(0);
  });

  test("with a plugin composed and no list to prove it gone, it still refuses", () => {
    const { dir, env } = project();
    writeFileSync(join(dir, ".claude", "tools", "data", "plugin-compose-left.json"), "{}\n");
    const res = sync(dir, env);
    expect(res.status).toBe(1);
    expect(res.out).toContain("host inventory unavailable");
  });
});

describe("the person's next step names a command they can take", () => {
  test("a plugin or knowledge verb that does not exist names the ones that do", () => {
    const plugin = resolveAction(["engine", "plugin", "frob"]);
    expect(plugin.type === "error" ? plugin.message : "").toBe(
      `\`${INVOKE} engine plugin frob\` is not a plugin command; the plugin commands are select, list, sync, validate and build\n`,
    );
    const help = resolveAction(["engine", "plugin"]);
    expect(help.type).toBe("noun-help");
    expect(help.type === "noun-help" ? help.message : "").toMatch(/^ {2}plugin sync \[--prune-missing\] +transactionally compose installed plugins$/m);
  });

  test("rolling back to a version this machine does not hold names the command that installs it", () => {
    const res = dispatch(["system", "rollback", "2.9.0"], join(REPO_ROOT, "dist", "claude"), {
      AIDLC_BIN_DIR: join(temp("aidlc-printed-rollback-bin-"), "bin"),
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain(
      `2.9.0 is not installed on this machine; run ${INVOKE} use 2.9.0 to install it and switch to it, or ${INVOKE} system rollback --list for the versions kept here`,
    );
  });

  test("a reference plugin's doctor fix names the entry of the harness it runs in", () => {
    const script = join(REPO_ROOT, "plugins", "test-pro", "tools", "test-pro-doctor.ts");
    for (const [dir, entry] of [[".claude", "/aidlc"], [".codex", "$aidlc"]]) {
      const res = spawnSync(BUN, [script], {
        encoding: "utf-8",
        env: { ...process.env, AIDLC_PROJECT_DIR: temp("aidlc-printed-plugin-doctor-"), AIDLC_HARNESS_DIR: dir },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      const fixes = (JSON.parse(res.stdout) as { checks: { fix: string }[] }).checks.map((check) => check.fix);
      expect(fixes.length).toBeGreaterThan(0);
      for (const fix of fixes) expect(fix, dir).toBe(`Run \`${entry} plugin sync\` (or re-run the plugin's \`hooks/compose.ts\`).`);
    }
    // The same entry the engine writes into each tree's runners.
    const codexRunner = readFileSync(join(REPO_ROOT, "dist", "codex", ".agents", "skills", "aidlc-compose", "SKILL.md"), "utf-8");
    expect(codexRunner).toContain("`$aidlc compose`");
  });
});
