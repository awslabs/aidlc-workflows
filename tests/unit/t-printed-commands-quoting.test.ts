// covers: function:quoteCommandArgument, function:broughtFilesLine, subcommand:aidlc-orchestrate:next, file:scripts/plugin-hooks-template/compose.ts (syncCommandForPlugin)
//
// A command AI-DLC prints with a folder or a name in it runs as printed: the
// folder reaches the command whole in the shell that reads it. On Windows the
// agent's shell is PowerShell or Git Bash, so a path with an apostrophe and
// backslashes (a user folder such as O'Brien) is quoted one way both read alike;
// a sibling repo whose folder has a space is quoted in the undo a gate gives; a
// doctor export folder with a space is quoted in the command the agent runs;
// and a plugin's "rules are not in the rule files yet" line names the plugin's
// folder, quoted, on every host whose tool keeps no plugin list. A copy
// install's launch with Bun's `--config=<file>` and `--no-env-file` reaches Bun
// as those two words from PowerShell, cmd.exe and Git Bash, so the project's own
// bunfig.toml and .env stay out of the process the launch starts.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { broughtFilesLine } from "../../dist/claude/.claude/tools/aidlc-brought-files.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
const COMPOSE = join(REPO_ROOT, "scripts", "plugin-hooks-template", "compose.ts");
const HAS_BASH = spawnSync("bash", ["-c", "true"]).status === 0;

// The one word a shell reads from `printed`, as that shell reads it.
function bashReads(printed: string): string {
  return spawnSync("bash", ["-c", `printf %s ${printed}`], { encoding: "utf-8" }).stdout;
}
function powershellReads(printed: string): string {
  return spawnSync("powershell", ["-NoProfile", "-Command", `[Console]::Out.Write(${printed})`], { encoding: "utf-8" }).stdout;
}

describe("a Windows path with an apostrophe reads alike in both shells an agent on Windows runs", () => {
  const paths = ["C:\\Users\\O'Brien\\proj", "C:\\Users\\O'Brien\\my proj\\.claude\\tools\\aidlc.ts"];

  test.skipIf(!HAS_BASH)("Git Bash reads the quoted path back whole", () => {
    for (const path of paths) expect(bashReads(quoteCommandArgument(path, "windows"))).toBe(path);
  });

  test.skipIf(process.platform !== "win32")("PowerShell reads the quoted path back whole", () => {
    for (const path of paths) expect(powershellReads(quoteCommandArgument(path, "windows"))).toBe(path);
  });

  test("a backslash bash reads as an escape keeps the PowerShell form", () => {
    expect(quoteCommandArgument("C:\\it's\\", "windows")).toBe("'C:\\it''s\\'");
    expect(quoteCommandArgument("\\\\server\\it's", "windows")).toBe("'\\\\server\\it''s'");
    // What would expand inside double quotes keeps it too, backslashes or not.
    expect(quoteCommandArgument("C:\\O'B\\$x", "windows")).toBe("'C:\\O''B\\$x'");
    expect(quoteCommandArgument("C:\\O'B\\`x", "windows")).toBe("'C:\\O''B\\`x'");
  });
});

describe("the undo for a file the build changed in a sibling repo names the repo whole", () => {
  test("a repo folder with a space is quoted", () => {
    const line = broughtFilesLine([{ repo: "my app", path: "README.md", ref: "HEAD", deleted: false } as never]);
    expect(line).toContain('`git -C "my app" checkout HEAD -- README.md`');
  });

  test("a repo folder no quoting passes in every shell gets no command, as a path like that gets none", () => {
    const line = broughtFilesLine([{ repo: "a$b", path: "README.md", ref: "HEAD", deleted: false } as never]);
    expect(line).not.toContain("git -C");
    expect(line).toContain("a$b/README.md");
  });
});

describe("a doctor export into a folder with a space names the folder whole", () => {
  test("the command the agent is given quotes the --output folder", () => {
    const outDir = join(tmpdir(), "My Folder", "out");
    const res = spawnSync(BUN, [ORCH, "next", "--doctor", "--export", "--output", outDir], {
      encoding: "utf-8",
      env: { ...process.env },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(res.status, res.stderr).toBe(0);
    const directive = JSON.parse(res.stdout.trim()) as { message: string };
    expect(directive.message).toContain(`--output ${quoteCommandArgument(outDir)}`);
  });
});

describe("a plugin's sync line names its folder on every host that keeps no plugin list", () => {
  // The harness's projected tree is the project, so the line is built by the
  // engine this harness ships.
  const trees: ReadonlyArray<{ harness: string; leaf: string; lists: boolean }> = [
    { harness: "claude", leaf: ".claude", lists: true },
    { harness: "codex", leaf: ".codex", lists: true },
    { harness: "cursor", leaf: ".cursor", lists: false },
    { harness: "copilot", leaf: ".aidlc", lists: false },
    { harness: "kiro-ide", leaf: ".kiro", lists: false },
    { harness: "opencode", leaf: ".aidlc", lists: false },
  ];
  const root = join(mkdtempSync(join(tmpdir(), "aidlc-sync-line-")), "my plugins", "test-pro");
  cpSync(join(REPO_ROOT, "plugins", "test-pro"), root, { recursive: true });

  for (const { harness, leaf, lists } of trees) {
    test(`${harness}: ${lists ? "no folder, the host lists it" : "the folder, quoted"}`, () => {
      const res = spawnSync(BUN, ["-e", `const m = await import(${JSON.stringify(COMPOSE)}); console.log(m.syncCommandForPlugin());`], {
        encoding: "utf-8",
        cwd: join(REPO_ROOT, "dist", harness),
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: join(REPO_ROOT, "dist", harness),
          AIDLC_HARNESS_DIR: leaf,
          AIDLC_HARNESS_NAME: harness,
          AIDLC_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_ROOT: "",
          PLUGIN_ROOT: "",
        },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(res.status, res.stderr).toBe(0);
      const line = res.stdout.trim();
      if (lists) expect(line).not.toContain("--plugin-root");
      else expect(line).toEndWith(` --plugin-root ${quoteCommandArgument(root)}`);
    });
  }
});

describe("a copy launch's two Bun options reach Bun whole from the shell that runs it", () => {
  // A scratch project in a folder with a space: the launch's config file (no
  // settings), a stand-in for the dispatcher that prints what Bun handed it, a
  // bunfig.toml at the root and in a subfolder whose preload writes a marker
  // file, and a .env that sets one name.
  const project = join(mkdtempSync(join(tmpdir(), "aidlc-copy-launch-")), "my project");
  const marker = join(project, "preload-ran.txt");
  const preload = `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`;
  const sub = join(project, "src", "app");
  for (const dir of [".codex", ".claude"]) {
    mkdirSync(join(project, dir, "tools"), { recursive: true });
    writeFileSync(join(project, dir, "tools", "aidlc-bunfig.toml"), "# no settings\n");
    writeFileSync(
      join(project, dir, "tools", "aidlc.ts"),
      "console.log(JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(2), dotenv: process.env.COPY_LAUNCH_DOTENV ?? null }));\n",
    );
  }
  mkdirSync(sub, { recursive: true });
  for (const dir of [project, sub]) {
    writeFileSync(join(dir, "preload.ts"), preload);
    writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(dir, ".env"), "COPY_LAUNCH_DOTENV=from-the-project\n");
  }

  // The shells find `bun` on PATH, as a hook does: the Bun running this file first.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project };
  delete env.COPY_LAUNCH_DOTENV;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [dirname(BUN), env[pathKey]].filter(Boolean).join(delimiter);

  const preloadRuns = (): number => existsSync(marker) ? readFileSync(marker, "utf-8").split("\n").length - 1 : 0;
  function launched(res: ReturnType<typeof spawnSync>): { execArgv: string[]; args: string[]; dotenv: string | null } {
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    return JSON.parse(String(res.stdout).trim().split(/\r?\n/).at(-1) ?? "");
  }
  const options = ["--config=.codex/tools/aidlc-bunfig.toml", "--no-env-file"];
  const relative = `bun ${options.join(" ")} .codex/tools/aidlc.ts engine adapter codex session-start`;

  test.skipIf(process.platform !== "win32")("Windows PowerShell hands Bun each option as one word", () => {
    const before = preloadRuns();
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", relative], {
      cwd: project,
      encoding: "utf-8",
      env,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const seen = launched(res);
    expect(seen.execArgv).toEqual(options);
    expect(seen.args).toEqual(["engine", "adapter", "codex", "session-start"]);
    expect(seen.dotenv).toBeNull();
    expect(preloadRuns()).toBe(before);
  });

  test.skipIf(process.platform !== "win32")("cmd.exe hands Bun each option as one word", () => {
    const before = preloadRuns();
    const res = spawnSync(relative, {
      cwd: project,
      encoding: "utf-8",
      env,
      shell: process.env.ComSpec ?? "cmd.exe",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const seen = launched(res);
    expect(seen.execArgv).toEqual(options);
    expect(seen.args).toEqual(["engine", "adapter", "codex", "session-start"]);
    expect(seen.dotenv).toBeNull();
    expect(preloadRuns()).toBe(before);
  });

  const skipBash = process.platform === "win32" ? gitBashSkipReason() : null;
  test.skipIf(skipBash !== null)("the hook bash runs, rooted at a project folder with a space, from a subfolder with its own bunfig.toml", () => {
    // Claude Code's hook spelling: the config path in the same quotes as the script.
    const before = preloadRuns();
    const hook = 'bun "--config=$CLAUDE_PROJECT_DIR/.claude/tools/aidlc-bunfig.toml" --no-env-file ' +
      '"$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook session-start';
    const res = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", ["-c", hook], {
      cwd: sub,
      encoding: "utf-8",
      env,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const seen = launched(res);
    expect(seen.execArgv).toEqual([`--config=${project}/.claude/tools/aidlc-bunfig.toml`, "--no-env-file"]);
    expect(seen.args).toEqual(["engine", "hook", "session-start"]);
    expect(seen.dotenv).toBeNull();
    expect(preloadRuns()).toBe(before);
  });

  test("the same launch without the options runs the project's preload and reads its .env", () => {
    const before = preloadRuns();
    const res = spawnSync(BUN, [join(project, ".claude", "tools", "aidlc.ts")], {
      cwd: sub,
      encoding: "utf-8",
      env,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(launched(res).dotenv).toBe("from-the-project");
    expect(preloadRuns()).toBe(before + 1);
  });
});
