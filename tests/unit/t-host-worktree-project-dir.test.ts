// covers: file:tools/aidlc-runtime-paths.ts, function:swarmWorkerWorktreeMeta
//
// A host that opens a session in a git worktree of the project may still name
// the main checkout as the project and run the session's hooks from it (Claude
// Code's desktop app sets CLAUDE_PROJECT_DIR that way). The hook payload says
// where the session works: the first cwd its transcript records, else its own
// cwd. That checkout is the project when it is another worktree of the same
// repository holding the AI-DLC workspace, and never when AI-DLC made it (a
// swarm Unit's worktree, which a conductor's kept `cd` can leave the payload
// naming). Tools and the copy channel keep the host's directory.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hookSessionDirectory,
  hookSessionProjectDir,
  hostWorktreeProjectDir,
  runtimeProjectDir,
} from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { swarmWorkerWorktreeMeta } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupCheckpointFixtures, fixture, prepare, wt } from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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

// A session transcript whose rows carry the cwd of their time.
function transcript(path: string, cwds: string[]): string {
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "bridge-session", sessionId: "s1" }),
      ...cwds.map((cwd) => JSON.stringify({ type: "user", cwd, sessionId: "s1" })),
    ].join("\n") + "\n",
  );
  return path;
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

  test("a worktree of the project holding the workspace is the session's project, from any folder inside it", () => {
    expect(realpathSync(hostWorktreeProjectDir(main, worktree) as string)).toBe(worktree);
    expect(realpathSync(hostWorktreeProjectDir(main, join(worktree, "aidlc")) as string)).toBe(worktree);
    expect(hostWorktreeProjectDir(main, main)).toBeNull();
  });

  test("a checkout without the AI-DLC workspace, another project, or no checkout at all, does not take over", () => {
    expect(hostWorktreeProjectDir(main, bare)).toBeNull();
    expect(hostWorktreeProjectDir(main, elsewhere)).toBeNull();
    // A separate clone holding a workspace is its own project, not a worktree
    // of the one the host named.
    const other = makeProject(join(base, "other"));
    expect(hostWorktreeProjectDir(main, other)).toBeNull();
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: other }))).toBe(main);
  });

  test("a worktree AI-DLC made is never the session's own, wherever it is", () => {
    // Under the project's .aidlc/worktrees/: refused before git runs.
    git(main, ["worktree", "add", "-q", join(main, ".aidlc", "worktrees", "bolt-x"), "-b", "bolt-x"]);
    expect(hostWorktreeProjectDir(main, join(main, ".aidlc", "worktrees", "bolt-x"))).toBeNull();
    // Elsewhere, holding the worktree metadata AI-DLC writes into its own.
    git(main, ["worktree", "add", "-q", join(base, "made"), "-b", "made"]);
    mkdirSync(join(base, "made", ".aidlc"));
    writeFileSync(join(base, "made", ".aidlc", "worktree-meta.json"), "{}\n");
    expect(hostWorktreeProjectDir(main, join(base, "made"))).toBeNull();
  });

  test("the session's directory is the first cwd its transcript records, else the payload's cwd", () => {
    const started = transcript(join(base, "started.jsonl"), [worktree, main]);
    expect(hookSessionDirectory(JSON.stringify({ cwd: main, transcript_path: started }))).toBe(worktree);
    expect(realpathSync(hookSessionProjectDir(main, JSON.stringify({ cwd: main, transcript_path: started }))))
      .toBe(worktree);
    // A session that started in the main checkout stays there, whatever its
    // payload's cwd names now.
    const stayed = transcript(join(base, "stayed.jsonl"), [main, worktree]);
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: worktree, transcript_path: stayed }))).toBe(main);
    // No transcript yet (the session's first hook): the payload's cwd.
    const missing = join(base, "missing.jsonl");
    expect(hookSessionDirectory(JSON.stringify({ cwd: worktree, transcript_path: missing }))).toBe(worktree);
    expect(realpathSync(hookSessionProjectDir(main, JSON.stringify({ cwd: worktree })))).toBe(worktree);
    // Nothing usable: the host's directory stands.
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: bare }))).toBe(main);
    expect(hookSessionProjectDir(main, JSON.stringify({ cwd: main }))).toBe(main);
    expect(hookSessionProjectDir(main, "not json")).toBe(main);
    expect(hookSessionProjectDir(main, JSON.stringify({ transcript_path: missing }))).toBe(main);
  });

  test("the copy channel's dispatcher runs a hook on the host's pin", () => {
    // The source dispatcher runs the host's own hook files, which act on the
    // host's directory, so the host's pin is the one that runs them.
    writeFileSync(join(main, ".aidlc-version"), "2.11.1-preview.20261013.999\n");
    const machine = join(base, "machine");
    mkdirSync(machine);
    const dispatcher = resolve(import.meta.dir, "../../dist/claude/.claude/tools/aidlc.ts");
    const hooked = spawnSync("bun", [dispatcher, "engine", "hook", "fold-usage"], {
      cwd: main,
      encoding: "utf-8",
      input: JSON.stringify({ session_id: "s1", cwd: worktree, hook_event_name: "PreToolUse", tool_name: "Bash" }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: main, AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") },
    });
    expect(hooked.stderr).toContain("this project's 2.11.1-preview.20261013.999 pin is not registered on this machine");
  });

  test("a tool keeps the host's directory", () => {
    process.chdir(worktree);
    process.env.CLAUDE_PROJECT_DIR = main;
    expect(realpathSync(runtimeProjectDir())).toBe(main);
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(realpathSync(runtimeProjectDir())).toBe(worktree);
  });
});

describe("a swarm Unit's worktree is never taken for the session's project", () => {
  afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

  test("a conductor's kept cd into a Unit's worktree leaves the hook on the project folder", () => {
    // The project's harness is committed, as a team's is, so the Unit's
    // worktree holds it too.
    const pd = fixture(["alpha"]);
    mkdirSync(join(pd, ".claude", "tools", "data"), { recursive: true });
    writeFileSync(join(pd, ".claude", "tools", "data", "harness.json"), JSON.stringify({ harnessDir: ".claude" }));
    git(pd, ["add", ".claude"]);
    git(pd, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "harness"]);
    const prepared = prepare(pd, ["alpha"]);
    expect(prepared.code, prepared.out + prepared.err).toBe(0);
    const alpha = wt(pd, "alpha");
    expect(swarmWorkerWorktreeMeta(alpha)).not.toBeNull();
    expect(existsSync(join(alpha, ".claude", "tools", "data", "harness.json"))).toBe(true);
    expect(hostWorktreeProjectDir(pd, alpha)).toBeNull();
    expect(hostWorktreeProjectDir(pd, join(alpha, "aidlc"))).toBeNull();
    // The payload's cwd names the Unit's worktree; the transcript says where
    // the session started.
    expect(hookSessionProjectDir(pd, JSON.stringify({ cwd: alpha }))).toBe(pd);
    const kept = transcript(join(pd, "..", `${pd.split(/[\\/]/).pop()}-session.jsonl`), [pd, alpha]);
    try {
      expect(hookSessionProjectDir(pd, JSON.stringify({ cwd: alpha, transcript_path: kept }))).toBe(pd);
    } finally {
      rmSync(kept, { force: true });
    }
  });
});
