// covers: function:repoDir, function:resolveIntentRepoSet, function:insideProject, function:workspaceTargetPath, function:repoNotThereLine, file:core/tools/aidlc-workspace-manifest.ts, file:core/tools/aidlc-workspace-repos.ts
//
// Repos anywhere on disk (#2410, item 1). repos.json can give a repo a `path`
// (relative to the workspace and outside it, absolute, or "." for the workspace
// itself), `org` is optional and a blank `url` is not set, and one person's
// uncommitted repos.local.json overrides `path`, `url` and `branch` for repos
// repos.json lists. repoDir is the one resolver; a mapped repo counts as the
// project for the plan-approval guard and the traceability sensor; work that
// records repos in a workspace with no repos.json is offered once to write it;
// one person on one repo sees nothing new.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoDir, resolveIntentRepoSet } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  localRepoOverrideLines,
  parseWorkspaceManifest,
  repoNotThereLine,
  workspaceGitignoreEntries,
} from "../../dist/claude/.claude/tools/aidlc-workspace-manifest.ts";
import { insideProject, workspaceTargetPath } from "../../dist/claude/.claude/tools/aidlc-workspace-repos.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seededStateFile,
} from "../harness/fixtures.ts";
import { SHAPES, SESSION, STATES } from "../harness/code-generation-states.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const SYNC = join(AIDLC_SRC, "tools", "aidlc-workspace-sync.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const D = String.fromCharCode(0x2014);

const dirs: string[] = [];
const projects: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const proj of projects) cleanupTestProject(proj);
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A folder holding the workspace and the places its repos live.
function layout(): { root: string; ws: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-repos-")));
  dirs.push(root);
  const ws = join(root, "work", "checkout");
  mkdirSync(ws, { recursive: true });
  return { root, ws };
}

function repoAt(dir: string, origin?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  if (origin) git(dir, ["remote", "add", "origin", origin]);
}

function bareWithCommit(root: string, name: string): string {
  const seed = join(root, `seed-${name}`);
  repoAt(seed);
  const bare = join(root, "hosts", `${name}.git`);
  mkdirSync(join(root, "hosts"), { recursive: true });
  git(root, ["clone", "-q", "--bare", seed, bare]);
  return bare;
}

function sync(ws: string, args: string[] = []): { status: number; out: string } {
  const result = spawnSync(BUN, [SYNC, "--project-dir", ws, ...args], {
    cwd: ws,
    encoding: "utf-8",
    env: GIT_ENV,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("repos.json: path, optional org, blank url", () => {
  test("org is optional, a blank url is not set, and path is read", () => {
    const manifest = parseWorkspaceManifest(
      '{ "repos": [ { "name": "checkout-api", "url": "", "path": "../checkout-api" }, { "name": "billing", "url": "  " } ] }',
    );
    expect(manifest.org).toBeUndefined();
    expect(manifest.repos).toEqual([
      { name: "checkout-api", path: "../checkout-api" },
      { name: "billing" },
    ]);
  });

  test("the managed ignore block lists only repos inside the workspace, never the workspace itself", () => {
    const manifest = parseWorkspaceManifest(
      '{ "repos": [ { "name": "a" }, { "name": "b", "path": "../b" }, { "name": "c", "path": "/srv/c" },' +
        ' { "name": "d", "path": "nested/d" }, { "name": "e", "path": "." } ] }',
    );
    expect(workspaceGitignoreEntries(manifest)).toEqual(["/.aidlc-workspace-sync-recovery-*/", "/a/", "/nested/d/"]);
  });
});

describe("repoDir is the one resolver", () => {
  test("no repos.json: an immediate child, as today", () => {
    const { ws } = layout();
    expect(repoDir(ws, "checkout-api")).toBe(join(ws, "checkout-api"));
  });

  test("a relative path outside the workspace, an absolute path, and the workspace itself", () => {
    const { root, ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({
      repos: [
        { name: "checkout-api", path: "../../checkout-api" },
        { name: "billing", path: join(root, "elsewhere", "billing") },
        { name: "platform", path: "." },
      ],
    }));
    expect(repoDir(ws, "checkout-api")).toBe(join(root, "checkout-api"));
    expect(repoDir(ws, "billing")).toBe(join(root, "elsewhere", "billing"));
    expect(repoDir(ws, "platform")).toBe(resolve(ws));
    expect(repoDir(ws, "unlisted")).toBe(join(ws, "unlisted"));
  });

  test("one person's repos.local.json overrides path for a listed repo; an unlisted name is one line and ignored", () => {
    const { root, ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../billing" }] }));
    writeFileSync(join(ws, "repos.local.json"), JSON.stringify({
      repos: [{ name: "billing", path: join(root, "src", "billing") }, { name: "extra", path: "../extra" }],
    }));
    expect(repoDir(ws, "billing")).toBe(join(root, "src", "billing"));
    expect(repoDir(ws, "extra")).toBe(join(ws, "extra"));
    expect(localRepoOverrideLines(ws)).toEqual([
      "repos.local.json names extra, which repos.json does not list, so it is ignored.",
    ]);
  });

  test.skipIf(process.platform !== "win32")("a path on another drive keeps its upper-case drive letter", () => {
    const { ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "d:/src/billing" }] }));
    expect(repoDir(ws, "billing")).toBe("D:\\src\\billing");
  });

  test("a missing checkout says where AI-DLC looked and the way forward", () => {
    const { ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../billing" }, { name: "web" }] }));
    expect(repoNotThereLine(ws, "billing")).toBe(
      "billing is not at ../billing, where repos.json puts it. Clone it there, or give its path in repos.local.json.",
    );
    expect(repoNotThereLine(ws, "web")).toBe(
      "web is not at web in this workspace. Clone it there, or give its path in repos.local.json.",
    );
    expect(repoNotThereLine(ws, "ghost")).toBe(
      "ghost is not at ghost in this workspace. Clone it there, or list it in repos.json with its path.",
    );
  });
});

describe("the repo set new work records", () => {
  test("declared repos wherever they live, plus every other child repo", () => {
    const { root, ws } = layout();
    repoAt(join(root, "work", "checkout-api"));
    repoAt(join(ws, "checkout-web"));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "checkout-api", path: "../checkout-api" }] }));
    expect(resolveIntentRepoSet(ws)).toEqual(["checkout-api", "checkout-web"]);
  });

  test("a child repo declared under another name is recorded once, by its declared name", () => {
    const { ws } = layout();
    repoAt(join(ws, "checkout-api"));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", path: "checkout-api" }] }));
    expect(resolveIntentRepoSet(ws)).toEqual(["api"]);
  });

  test("a workspace whose one repo is itself records none, as a one-repo workspace always has", () => {
    const { ws } = layout();
    repoAt(ws);
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "platform", path: "." }] }));
    expect(resolveIntentRepoSet(ws)).toEqual([]);
  });

  test("the workspace itself alongside a repo elsewhere is recorded with it", () => {
    const { root, ws } = layout();
    repoAt(ws);
    repoAt(join(root, "billing"));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({
      repos: [{ name: "platform", path: "." }, { name: "billing", path: "../../billing" }],
    }));
    expect(resolveIntentRepoSet(ws)).toEqual(["billing", "platform"]);
  });
});

describe("a mapped repo counts as the project", () => {
  test("a target in a mapped repo is inside the project; one elsewhere is not", () => {
    const { root, ws } = layout();
    repoAt(join(root, "billing"));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../../billing" }] }));
    expect(insideProject(ws, join(root, "billing", "src", "refund.ts"))).toBe(true);
    expect(insideProject(ws, join(ws, "src", "x.ts"))).toBe(true);
    expect(insideProject(ws, join(root, "unrelated", "x.ts"))).toBe(false);
  });

  test("a traceability target in a mapped repo is spelled <repo>/<path> and resolves there", () => {
    const { root, ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../../billing" }] }));
    expect(workspaceTargetPath(ws, "billing/src/refund.ts")).toEqual({
      root: join(root, "billing"),
      absolute: join(root, "billing", "src", "refund.ts"),
    });
    expect(workspaceTargetPath(ws, "src/x.ts")).toEqual({ root: resolve(ws), absolute: join(ws, "src", "x.ts") });
  });

  test("a build writing into a mapped repo still waits for Plan Approval", async () => {
    const built = STATES.find((state) => state.id === "S3")!.build();
    projects.push(built.proj);
    const billing = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-repos-billing-")));
    dirs.push(billing);
    repoAt(billing);
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-repos-elsewhere-")));
    dirs.push(elsewhere);
    const claude = SHAPES.find((shape) => shape.name === "claude")!;
    // Not mapped yet: a write outside the project is not the plan's business.
    expect((await claude.call(built.proj, SESSION, { tool: "Write", path: join(billing, "src", "refund.ts") })).code).toBe(0);
    writeFileSync(join(built.proj, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: billing }] }));
    const mapped = await claude.call(built.proj, SESSION, { tool: "Write", path: join(billing, "src", "refund.ts") });
    expect(mapped.code, mapped.said).toBe(2);
    expect((await claude.call(built.proj, SESSION, { tool: "Write", path: join(elsewhere, "notes.txt") })).code).toBe(0);
  });
});

describe("workspace-sync clones to the path, by path", () => {
  test("a repo mapped outside the workspace is cloned there; the ignore block leaves it out", () => {
    const { root, ws } = layout();
    const bare = bareWithCommit(root, "billing");
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: bare, path: "../billing" }] }));
    const result = sync(ws);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(root, "work", "billing", ".git"))).toBe(true);
    expect(existsSync(join(ws, "billing"))).toBe(false);
    const ignore = readFileSync(join(ws, ".gitignore"), "utf-8");
    expect(ignore).not.toContain("/billing/");
    const workspaceFile = JSON.parse(readFileSync(join(ws, "aidlc.code-workspace"), "utf-8"));
    expect(workspaceFile.folders).toEqual([{ path: "." }, { path: "../billing" }]);
  });

  test("one person's repos.local.json path is where their clone goes", () => {
    const { root, ws } = layout();
    const bare = bareWithCommit(root, "billing");
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: bare, path: "../billing" }] }));
    writeFileSync(join(ws, "repos.local.json"), JSON.stringify({ repos: [{ name: "billing", path: join(root, "src", "billing") }] }));
    const result = sync(ws);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(root, "src", "billing", ".git"))).toBe(true);
    expect(existsSync(join(root, "work", "billing"))).toBe(false);
  });

  test("a blank url with no org is not cloned, and one line names how to add a url", () => {
    const { ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: "", path: "../billing" }] }));
    const result = sync(ws);
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain(
      "billing is not at ../billing, where repos.json puts it. Clone it there, or give its path in repos.local.json. " +
        'repos.json gives it no "url" and no "org" to clone it from: add its "url" in repos.json, or in repos.local.json for your own copy.',
    );
  });

  test("a child repo declared under another name is never an orphan", () => {
    const { ws } = layout();
    repoAt(join(ws, "checkout-api"));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", path: "checkout-api" }] }));
    const result = sync(ws, ["--force"]);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(ws, "checkout-api", ".git"))).toBe(true);
  });

  test("--write-manifest writes each found repo with the address its origin points to, and changes no origin", () => {
    const { ws } = layout();
    repoAt(join(ws, "checkout-api"), "git@github.com:your-org/checkout-api.git");
    repoAt(join(ws, "billing"));
    const before = git(join(ws, "checkout-api"), ["config", "--get-regexp", "^remote\\."]);
    const result = sync(ws, ["--write-manifest"]);
    expect(result.status, result.out).toBe(0);
    expect(JSON.parse(readFileSync(join(ws, "repos.json"), "utf-8"))).toEqual({
      repos: [
        { name: "billing", url: "", path: "billing" },
        { name: "checkout-api", url: "git@github.com:your-org/checkout-api.git", path: "checkout-api" },
      ],
    });
    expect(git(join(ws, "checkout-api"), ["config", "--get-regexp", "^remote\\."])).toBe(before);
    expect(result.out).toContain('billing has no origin, so its "url" is blank for now.');
  });
});

// A feature plan between two stages: Requirements Analysis done and approved,
// User Stories next; with `home`, work built by teams (a Unit's build records
// where its home is).
function boundaryState(home = false): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: repos anywhere test
- **Project Type**: Brownfield
- **Scope**: feature
- **State Version**: 8
${home ? "\n## Runtime State\n- **Home Location**: git@github.com:your-org/workspace.git\n" : ""}
## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] requirements-analysis ${D} EXECUTE
- [ ] user-stories ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: requirements-analysis
- **Status**: Running
`;
}

function boundaryProject(repos: string[], home = true): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), boundaryState(home));
  for (const name of repos) repoAt(join(proj, name));
  if (repos.length > 0) {
    const registryPath = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = repos;
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
  return proj;
}

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};

function next(proj: string): Record<string, unknown> {
  const result = runOrchestrateNext(ORCH, proj, [], { env: ENV });
  if (!result.directive) throw new Error(`next failed: ${result.out}`);
  return result.directive;
}

describe("the one offer to write repos.json", () => {
  test("work built by teams that records repos, in a workspace with none, is offered once at a stage boundary", () => {
    const proj = boundaryProject(["checkout-api", "checkout-web"]);
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("repos-manifest");
    expect(ask.response_route).toBe("command");
    expect(ask.question).toBe(
      "Write repos.json from the 2 repos found here (checkout-api, checkout-web)? It lists each one's folder and " +
        "the address its origin points to, so a teammate's clone knows where they go.",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Write it", "Not now"]);
    expect(choices[0].command).toEndWith("--write-manifest");
    const after = next(proj);
    expect(after.ask_type, JSON.stringify(after)).not.toBe("repos-manifest");
  });

  test("one person on one repo is never offered it", () => {
    const proj = boundaryProject([]);
    const step = next(proj);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
  });

  test("work one person builds, and team work with no home recorded, are never offered it", () => {
    expect(next(boundaryProject(["checkout-api", "checkout-web"], false)).ask_type).not.toBe("repos-manifest");
    const today = boundaryProject(["checkout-api", "checkout-web"], false);
    writeFileSync(seededStateFile(today), boundaryState().replace("## Scope Configuration", "## Runtime State\n- **Unit Ownership**: team\n\n## Scope Configuration"));
    expect(next(today).ask_type).not.toBe("repos-manifest");
  });

  test("a workspace that already has repos.json is never offered it", () => {
    const proj = boundaryProject(["checkout-api", "checkout-web"]);
    writeFileSync(join(proj, "repos.json"), JSON.stringify({ repos: [{ name: "checkout-api" }, { name: "checkout-web" }] }));
    const step = next(proj);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
  });
});
