// covers: function:quoteCommandArgument, function:broughtFilesLine, subcommand:aidlc-orchestrate:next, file:scripts/plugin-hooks-template/compose.ts (syncCommandForPlugin)
//
// A command AI-DLC prints with a folder or a name in it runs as printed: the
// folder reaches the command whole in the shell that reads it. On Windows the
// agent's shell is PowerShell or Git Bash, so a path with an apostrophe and
// backslashes (a user folder such as O'Brien) is quoted one way both read alike;
// a sibling repo whose folder has a space is quoted in the undo a gate gives; a
// doctor export folder with a space is quoted in the command the agent runs;
// and a plugin's "rules are not in the rule files yet" line names the plugin's
// folder, quoted, on every host whose tool keeps no plugin list.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broughtFilesLine } from "../../dist/claude/.claude/tools/aidlc-brought-files.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
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
