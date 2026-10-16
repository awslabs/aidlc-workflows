// covers: file:tools/aidlc-runtime-paths.ts
//
// A host that opens a session in a git worktree of the project may still name
// the main checkout as the project (Claude Code's desktop app sets
// CLAUDE_PROJECT_DIR that way). A hook then runs with the worktree as its
// working directory: it must act on the worktree, not on the main checkout.
// AIDLC_PROJECT_DIR, the engine's own variable, still wins.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hookSessionDirectories,
  hookSessionProjectDir,
  hostWorktreeProjectDir,
  runtimeProjectDir,
} from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

// A project: a git checkout holding the AI-DLC workspace and a harness.
function makeProject(root: string): string {
  mkdirSync(join(root, "aidlc"), { recursive: true });
  writeFileSync(join(root, "aidlc", "active-space"), "default\n");
  mkdirSync(join(root, ".claude", "tools", "data"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "tools", "data", "harness.json"),
    JSON.stringify({ harnessDir: ".claude" }),
  );
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.test", "add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "project"]);
  return realpathSync(root);
}

const ENV_KEYS = ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "KIRO_PROJECT_DIR"] as const;

describe("a hook in a host's worktree acts on that worktree", () => {
  let base = "";
  let main = "";
  let worktree = "";
  let bare = "";
  let elsewhere = "";
  const cwd = process.cwd();
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aidlc-host-wt-"));
    main = makeProject(join(base, "main"));
    git(main, ["worktree", "add", "-q", join(base, "wt"), "-b", "feature"]);
    worktree = realpathSync(join(base, "wt"));
    // A checkout that is not an AI-DLC project: no workspace, no harness.
    bare = join(base, "bare");
    mkdirSync(bare);
    writeFileSync(join(bare, "README.md"), "not a project\n");
    git(bare, ["init", "-q", "-b", "main"]);
    git(bare, ["-c", "user.name=t", "-c", "user.email=t@example.test", "add", "-A"]);
    git(bare, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "bare"]);
    bare = realpathSync(bare);
    elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  test("the worktree the hook runs in is the project when the host names the main checkout", () => {
    process.chdir(worktree);
    expect(realpathSync(hostWorktreeProjectDir(main) as string)).toBe(worktree);
  });

  test("the main checkout stays the project when the hook runs in it", () => {
    process.chdir(main);
    expect(hostWorktreeProjectDir(main)).toBeNull();
  });

  test("a checkout without the AI-DLC workspace, another project, or no checkout at all, does not take over", () => {
    process.chdir(bare);
    expect(hostWorktreeProjectDir(main)).toBeNull();
    process.chdir(elsewhere);
    expect(hostWorktreeProjectDir(main)).toBeNull();
    // A separate clone holding a workspace is its own project, not a worktree
    // of the one the host named.
    const other = makeProject(join(base, "other"));
    process.chdir(other);
    expect(hostWorktreeProjectDir(main)).toBeNull();
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: other }))).toBe(main);
  });

  test("a hook run from the main checkout follows the session's directory named by its payload", () => {
    process.chdir(main);
    // The payload's own cwd: the worktree, or a directory inside it.
    expect(realpathSync(hostWorktreeProjectDir(main, worktree) as string)).toBe(worktree);
    expect(realpathSync(hookSessionProjectDir(main, JSON.stringify({ cwd: worktree })))).toBe(worktree);
    expect(realpathSync(hookSessionProjectDir(main, JSON.stringify({ cwd: join(worktree, "aidlc") })))).toBe(worktree);
    // The transcript's cwd when the payload's cwd is the main checkout itself.
    const transcript = join(base, "session.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "bridge-session", sessionId: "s1" })}\n` +
        `${JSON.stringify({ type: "user", cwd: worktree, sessionId: "s1" })}\n` +
        `${JSON.stringify({ type: "assistant", cwd: worktree, sessionId: "s1" })}\n`,
    );
    expect(hookSessionDirectories(JSON.stringify({ cwd: main, transcript_path: transcript }))).toEqual([main, worktree]);
    expect(realpathSync(hookSessionProjectDir(main, JSON.stringify({ cwd: main, transcript_path: transcript })))).toBe(worktree);
    // Nothing usable: the host's directory stands.
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: bare }))).toBe(main);
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: elsewhere }))).toBe(main);
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: main }))).toBe(main);
    expect(hookSessionProjectDir(main, "not json")).toBe(main);
    expect(hookSessionProjectDir(main, JSON.stringify({ transcript_path: join(base, "missing.jsonl") }))).toBe(main);
  });

  test("a hook run from the main checkout runs on the pin of the checkout its payload names", () => {
    // The main checkout declares a release this machine never registered (it
    // was pulled to a newer shell); the worktree the session works in declares
    // none. The hook acts on the worktree, so the main checkout's pin must not
    // stop it.
    writeFileSync(join(main, ".aidlc-version"), "2.11.1-preview.20261013.999\n");
    const machine = join(base, "machine");
    mkdirSync(machine);
    const dispatcher = resolve(import.meta.dir, "../../dist/claude/.claude/tools/aidlc.ts");
    const hook = (payloadCwd: string) => spawnSync("bun", [dispatcher, "engine", "hook", "fold-usage"], {
      cwd: main,
      encoding: "utf-8",
      input: JSON.stringify({ session_id: "s1", cwd: payloadCwd, hook_event_name: "PreToolUse", tool_name: "Bash" }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: main, AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") },
    });
    const inWorktree = hook(worktree);
    expect(inWorktree.stderr).not.toContain("pin is not registered");
    // The main checkout's own session still answers to the main checkout's pin.
    const inMain = hook(main);
    expect(inMain.stderr).toContain("this project's 2.11.1-preview.20261013.999 pin is not registered on this machine");
  });

  test("the runtime project dir follows the worktree for the host's variable and AIDLC_PROJECT_DIR as given", () => {
    process.chdir(worktree);
    process.env.CLAUDE_PROJECT_DIR = main;
    expect(realpathSync(runtimeProjectDir())).toBe(worktree);
    process.env.AIDLC_PROJECT_DIR = main;
    expect(realpathSync(runtimeProjectDir())).toBe(main);
    delete process.env.AIDLC_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.KIRO_PROJECT_DIR = main;
    expect(realpathSync(runtimeProjectDir())).toBe(worktree);
    delete process.env.KIRO_PROJECT_DIR;
    expect(realpathSync(runtimeProjectDir())).toBe(worktree);
  });
});
