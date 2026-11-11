// covers: function:enclosingProjectDir, function:isAidlcProjectFolder, function:moduleProjectDir, file:tools/aidlc.ts
// An AI-DLC command the agent runs from a folder inside the person's workspace
// that is not a project of its own (a code repo cloned beside `aidlc/`, a
// plain subfolder) acts on the workspace, as from its root: the decision is
// recorded there and nothing of AI-DLC's lands in the code repo (#3770: a
// field check on 2.11.3 left `aidlc/.aidlc-sessions/` in the repo and told the
// agent "No active workflow is selected"). The dispatcher runs from a copy of
// the engine whose own path names no project, as the compiled engine's payload
// does, and from a compiled build. A folder that is a project of its own (set
// up, records, a Unit worktree AI-DLC made), a project named by flag or env,
// `aidlc config`, the copy channel (its path names its project) and a workspace
// holding AI-DLC's own machine folders keep the folder they had.
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enclosingProjectDir, isAidlcProjectFolder } from "../../core/tools/aidlc-runtime-paths.ts";
import { readAllAuditShards } from "../../core/tools/aidlc-lib.ts";
import {
  cleanupTestProject, createTestProject, REPO_ROOT, seedAidlcMemory, seedStateFile, seedWorkspaceShell,
} from "../harness/fixtures.ts";
import { cleanupCheckpointFixtures, fixture, prepare, wt } from "../harness/swarm-checkpoint.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CLAUDE_TREE = join(REPO_ROOT, "dist", "claude", ".claude");
const SESSION = "6b0c3f7e-1d2a-4c5b-9e8f-0a1b2c3d4e5f";
const QUESTION = "How would you like to answer the questions?";
const ENGINE_HOME = mkdtempSync(join(tmpdir(), "aidlc-ecr-engine-"));
const DISPATCHER = join(ENGINE_HOME, "engine", "tools", "aidlc.ts");
const made: string[] = [ENGINE_HOME];

beforeAll(() => {
  cpSync(CLAUDE_TREE, join(ENGINE_HOME, "engine"), { recursive: true });
});

afterAll(() => {
  for (const dir of made) cleanupTestProject(dir);
});

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
}

// A workspace set up with AI-DLC (its install and its records, one active
// piece of work), the way `aidlc config` leaves it.
function workspace(): string {
  const hub = createTestProject();
  made.push(hub);
  seedAidlcMemory(hub);
  seedStateFile(hub, "state-brownfield-feature.md");
  cpSync(CLAUDE_TREE, join(hub, ".claude"), { recursive: true });
  return hub;
}

// A code repo of the person's: its own git and a project file, nothing of AI-DLC's.
function codeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "package.json"), '{ "name": "svc" }\n');
  return dir;
}

// The environment of an agent's shell: no project named by the host.
function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION, ...extra };
  for (const name of [
    "AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "KIRO_PROJECT_DIR", "AIDLC_RUNTIME_PROJECT_DIR", "AIDLC_HARNESS_DIR",
    "AIDLC_HARNESS_NAME", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AIDLC_SESSION_OVERRIDE_SOURCE",
  ]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

function decide(command: string[], cwd: string, env = agentEnv()) {
  const r = spawnSync(command[0], [
    ...command.slice(1), "engine", "log", "decision", "--stage", "requirements-analysis",
    "--decision", QUESTION, "--options", "Guide me,Edit the file,Chat", "--question-kind", "answer-mode",
  ], { cwd, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const fromEngine = (cwd: string, env?: NodeJS.ProcessEnv) => decide([process.execPath, DISPATCHER], cwd, env);
const recorded = (project: string) => readAllAuditShards(project).includes(QUESTION);

describe("t-engine-from-code-repo: the folder a project-required command acts on", () => {
  test("a decision recorded from a code repo of the workspace lands in the workspace", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    const r = fromEngine(svc);
    expect(r.status, r.out).toBe(0);
    expect(recorded(hub)).toBe(true);
    expect(existsSync(join(svc, "aidlc"))).toBe(false);
  });

  test("the same two levels down, from a repo under src/", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "src", "svc"));
    const r = fromEngine(svc);
    expect(r.status, r.out).toBe(0);
    expect(recorded(hub)).toBe(true);
    expect(existsSync(join(svc, "aidlc"))).toBe(false);
  });

  test("a code repo still holding the session folder an earlier run left is not a project", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    mkdirSync(join(svc, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(join(svc, "aidlc", ".aidlc-sessions", `${SESSION}.binding.json`),
      '{"space":"default","intent":null,"boundAt":"2026-11-11T01:29:12Z","source":"none"}\n');
    const r = fromEngine(svc);
    expect(r.status, r.out).toBe(0);
    expect(recorded(hub)).toBe(true);
    expect(readdirSync(join(svc, "aidlc", ".aidlc-sessions"))).toEqual([`${SESSION}.binding.json`]);
  });

  test("a plain folder of the workspace acts on the workspace", () => {
    const hub = workspace();
    const docs = join(hub, "docs");
    mkdirSync(docs);
    const r = fromEngine(docs);
    expect(r.status, r.out).toBe(0);
    expect(recorded(hub)).toBe(true);
    expect(existsSync(join(docs, "aidlc"))).toBe(false);
  });

  test("a project the command or the host names wins", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    for (const env of [agentEnv({ CLAUDE_PROJECT_DIR: svc }), agentEnv({ AIDLC_PROJECT_DIR: svc })]) {
      fromEngine(svc, env);
      expect(recorded(hub)).toBe(false);
    }
    decide([process.execPath, DISPATCHER, "--project-dir", svc], hub);
    expect(recorded(hub)).toBe(false);
  });

  test("aidlc config from a code repo of the workspace still plans that repo", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    const r = spawnSync(process.execPath, [
      DISPATCHER, "config", "--harness", "claude", "--mcp", "none", "--dry-run",
      "--from", join(REPO_ROOT, "dist-release", "claude"),
    ], { cwd: svc, env: agentEnv(), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`config plan for ${svc}:`);
  });

  test("the copy channel's own tool acts on the project its path names", () => {
    const hub = workspace();
    const other = createTestProject();
    made.push(other);
    const otherSvc = codeRepo(join(other, "svc"));
    const r = decide([process.execPath, join(hub, ".claude", "tools", "aidlc.ts")], otherSvc);
    expect(r.status, r.out).toBe(0);
    expect(recorded(hub)).toBe(true);
    expect(recorded(other)).toBe(false);
  });

  test("a workspace holding AI-DLC's own machine folder is not taken for the repo's project", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    const r = fromEngine(svc, agentEnv({ AIDLC_INSTALL_ROOT: join(hub, ".machine", "aidlc") }));
    expect(r.out).not.toMatch(/can't run in|machine install or command directory/);
    expect(recorded(hub)).toBe(false);
  });
});

describe("t-engine-from-code-repo: enclosingProjectDir", () => {
  test("a folder below a project that is not one itself names that project; a project names none", () => {
    const hub = workspace();
    expect(isAidlcProjectFolder(hub)).toBe(true);
    expect(enclosingProjectDir(hub)).toBeNull();
    // The walk names the folder in this platform's own spelling.
    expect(enclosingProjectDir(codeRepo(join(hub, "svc")))).toBe(resolve(hub));
    expect(enclosingProjectDir(codeRepo(join(hub, "src", "a")))).toBe(resolve(hub));
    const record = join(hub, "aidlc", "spaces", "default", "intents", "x");
    mkdirSync(record, { recursive: true });
    expect(enclosingProjectDir(record)).toBe(resolve(hub));
  });

  test("records, an install or a Unit worktree of its own make a folder its own project", () => {
    const hub = workspace();
    const records = codeRepo(join(hub, "records"));
    mkdirSync(join(records, "aidlc", "spaces"), { recursive: true });
    expect(enclosingProjectDir(records)).toBeNull();
    const installed = codeRepo(join(hub, "installed"));
    cpSync(CLAUDE_TREE, join(installed, ".claude"), { recursive: true });
    expect(enclosingProjectDir(installed)).toBeNull();
    const bolt = join(hub, ".aidlc", "worktrees", "intent-1234abcd", "bolt-alpha");
    mkdirSync(join(bolt, ".aidlc"), { recursive: true });
    writeFileSync(join(bolt, ".aidlc", "worktree-meta.json"), '{"swarmUnit":"alpha"}\n');
    expect(isAidlcProjectFolder(bolt)).toBe(true);
    expect(enclosingProjectDir(bolt)).toBeNull();
    mkdirSync(join(bolt, "src"));
    expect(enclosingProjectDir(join(bolt, "src"))).toBe(resolve(bolt));
  });

  test("a folder in no project names none", () => {
    const base = mkdtempSync(join(tmpdir(), "aidlc-enclosing-"));
    made.push(base);
    expect(enclosingProjectDir(codeRepo(join(base, "lone", "svc")))).toBeNull();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a folder it cannot read on the way up ends the walk",
    () => {
      const hub = workspace();
      const locked = join(hub, "locked");
      const svc = codeRepo(join(locked, "svc"));
      chmodSync(locked, 0o311);
      try {
        expect(enclosingProjectDir(svc)).toBeNull();
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("t-engine-from-code-repo: the compiled engine", () => {
  let binary: string;
  beforeAll(() => {
    const scratch = mkdtempSync(join(tmpdir(), "aidlc-ecr-"));
    made.push(scratch);
    binary = join(scratch, process.platform === "win32" ? "aidlc.exe" : "aidlc");
    const build = spawnSync(process.execPath, [
      "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", binary,
    ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    cpSync(join(REPO_ROOT, "dist-release", "claude"), join(scratch, "runtime", "claude"), { recursive: true });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a decision the native engine records from a code repo of the workspace lands in the workspace", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    const r = decide([binary], svc);
    expect(r.status, r.out).toBe(0);
    expect(recorded(hub)).toBe(true);
    expect(existsSync(join(svc, "aidlc"))).toBe(false);
  });

  test("a repo set up with AI-DLC of its own keeps its own records", () => {
    const hub = workspace();
    const svc = codeRepo(join(hub, "svc"));
    seedWorkspaceShell(svc);
    seedAidlcMemory(svc);
    seedStateFile(svc, "state-brownfield-feature.md");
    cpSync(CLAUDE_TREE, join(svc, ".claude"), { recursive: true });
    const r = decide([binary], svc);
    expect(r.status, r.out).toBe(0);
    expect(recorded(svc)).toBe(true);
    expect(recorded(hub)).toBe(false);
  });
});

describe("t-engine-from-code-repo: a Unit's worktree", () => {
  afterAll(() => cleanupCheckpointFixtures());

  test("the conductor's command run in a Unit's worktree still gets orchestrate's own way back", () => {
    const pd = fixture();
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const r = spawnSync(process.execPath, [DISPATCHER, "engine", "orchestrate", "next"], {
      cwd: wt(pd), env: agentEnv(), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(`${r.stdout}\n${r.stderr}`).toContain("This ran in the folder AI-DLC made for Unit alpha's build");
  });
});
