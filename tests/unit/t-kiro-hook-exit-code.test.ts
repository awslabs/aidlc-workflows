// covers: file:scripts/package.ts
//
// Kiro CLI starts every hook through a shell: `/bin/bash -c "<command>"` on
// Linux and `"powershell" -Command "<command>"` on Windows (both measured on
// kiro-cli 2.34.0), and it stops a tool call only when a preToolUse hook exits
// 2. Windows PowerShell's -Command hands back 1 for any native exit code but 0
// and 1, so on Windows no AI-DLC refusal stopped anything: the agent's altered
// first `next` ran and the person's request was recorded in words they did not
// write. Every hook command the Kiro CLI agents ship carries the manifest's exit
// shape, and a refusal run the way Kiro runs it exits 2 in both shells.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import kiro from "../../harness/kiro/manifest.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const KIRO_TREE = join(REPO_ROOT, "dist", "kiro", ".kiro");
const WINDOWS = process.platform === "win32";

type Agent = { hooks?: Record<string, Array<{ command: string }>> };

function shippedCommands(): Array<{ agent: string; event: string; command: string }> {
  const dir = join(KIRO_TREE, "agents");
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().flatMap((agent) => {
    const hooks = (JSON.parse(readFileSync(join(dir, agent), "utf-8")) as Agent).hooks ?? {};
    return Object.entries(hooks).flatMap(([event, rows]) => rows.map(({ command }) => ({ agent, event, command })));
  });
}

function shipped(target: string): string {
  const hooks = (JSON.parse(readFileSync(join(KIRO_TREE, "agents", "aidlc.json"), "utf-8")) as Agent).hooks ?? {};
  const line = Object.values(hooks).flat().map(({ command }) => command)
    .find((command) => command.includes(` engine adapter kiro ${target}`));
  if (line === undefined) throw new Error(`agents/aidlc.json wires no ${target}`);
  return line;
}

// The hook line run the way Kiro CLI runs it on this platform.
function asKiroRuns(line: string, cwd: string, input: string, path: string) {
  const [shell, ...args] = WINDOWS
    ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", line]
    : ["/bin/bash", "-c", line];
  return spawnSync(shell, args, {
    cwd,
    input,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, AIDLC_SESSION_OVERRIDE: "t-kiro-hook-exit-code", PATH: path },
  });
}

describe("a Kiro CLI hook's exit code reaches Kiro as the hook set it", () => {
  test("every hook command the Kiro CLI agents ship ends with the manifest's exit shape", () => {
    const suffix = kiro.hookCommandSuffix;
    expect(suffix).toBe("; exit $LASTEXITCODE");
    const commands = shippedCommands();
    expect(commands.length).toBeGreaterThan(0);
    for (const { agent, event, command } of commands) {
      expect(command.endsWith(suffix ?? "\0"), `${agent} ${event}: ${command}`).toBe(true);
      expect(command.slice(0, -(suffix ?? "").length), `${agent} ${event}`)
        .toMatch(/^bun \.kiro\/tools\/aidlc\.ts engine adapter kiro [a-z-]+(?: [a-z-]+)?$/);
    }
  });

  test("a refusal run the way Kiro runs it exits 2, the call as told exits 0, and the prompt hook's context is unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-kiro-hook-exit-"));
    try {
      cpSync(KIRO_TREE, join(dir, ".kiro"), { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: dir });
      const path = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
      const skill = readFileSync(join(dir, ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
      const prompt = asKiroRuns(shipped("verb-intercept"), dir, JSON.stringify({
        hook_event_name: "userPromptSubmit",
        cwd: dir,
        session_id: "t-kiro-hook-exit-code",
        prompt: skill.replaceAll("$ARGUMENTS", "fix the login page, please"),
      }), path);
      expect(prompt.status, prompt.stderr).toBe(0);
      expect(prompt.stdout).toContain("Your first tool call is exactly the call below");
      const forwarded = /engine orchestrate next (.*)\n/.exec(prompt.stdout)?.[1] ?? "";
      expect(forwarded.length).toBeGreaterThan(0);
      const guard = (command: string) => asKiroRuns(shipped("guard-tool-call"), dir, JSON.stringify({
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "shell",
        tool_input: { command },
      }), path);
      // The agent's rewrite seen live: the whole line inside one pair of double quotes.
      const altered = guard(`bun .kiro/tools/aidlc.ts engine orchestrate next "${forwarded}"`);
      expect(altered.status, altered.stderr).toBe(2);
      expect(altered.stderr).toContain("Run exactly:");
      const asTold = guard(`bun .kiro/tools/aidlc.ts engine orchestrate next ${forwarded}`);
      expect(asTold.status, asTold.stderr).toBe(0);
      expect(existsSync(join(dir, "aidlc", ".aidlc-forwarding-latch"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the native release's line keeps the launcher's exit code through the same shell", () => {
    // The native release ships the same line with `aidlc` for the copy's `bun .kiro/tools/aidlc.ts`;
    // a stand-in launcher that refuses stands for it here (aidlc.cmd on Windows).
    const bin = mkdtempSync(join(tmpdir(), "t-kiro-hook-exit-bin-"));
    try {
      if (WINDOWS) {
        writeFileSync(join(bin, "aidlc.cmd"), "@echo refused 1>&2\r\n@exit /b 2\r\n");
      } else {
        writeFileSync(join(bin, "aidlc"), "#!/bin/sh\necho refused >&2\nexit 2\n", { mode: 0o755 });
      }
      const line = shipped("guard-tool-call").replace("bun .kiro/tools/aidlc.ts", "aidlc");
      mkdirSync(join(bin, "proj"));
      const run = asKiroRuns(line, join(bin, "proj"), "{}", `${bin}${delimiter}${process.env.PATH ?? ""}`);
      expect(run.status, `${line}: ${run.stderr}`).toBe(2);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
