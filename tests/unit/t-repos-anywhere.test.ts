// covers: function:repoDir, function:resolveIntentRepoSet, function:sourceKeyRegistryFiles, function:insideProject, function:workspaceTargetPath, function:repoNotThereLine, function:removeOutsideStages, function:takeStagingLeftLines, function:stagingLeftLine, file:core/tools/aidlc-workspace-manifest.ts, file:core/tools/aidlc-workspace-repos.ts
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadStageGraph, repoDir, resolveIntentRepoSet, sourceKeyRegistryFiles, sourcePathKey } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-artifact-vocabulary.ts";
import {
  localRepoOverrideLines,
  parseWorkspaceManifest,
  repoNotThereLine,
  workspaceGitignoreEntries,
} from "../../dist/claude/.claude/tools/aidlc-workspace-manifest.ts";
import { insideProject, workspaceTargetPath } from "../../dist/claude/.claude/tools/aidlc-workspace-repos.ts";
import { removeOutsideStages, takeStagingLeftLines } from "../../dist/claude/.claude/tools/aidlc-workspace-sync.ts";
import { detectWorkspace } from "../../dist/claude/.claude/tools/aidlc-utility.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { SHAPES, SESSION, STATES } from "../harness/code-generation-states.ts";
import { projectAt, templateProjects } from "../harness/aidlc-answers-corpus.ts";
import { env as runEnv, exec, next as liveNext, say } from "../harness/aidlc-input-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const SYNC = join(AIDLC_SRC, "tools", "aidlc-workspace-sync.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const D = String.fromCharCode(0x2014);

const dirs: string[] = [];
const projects: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
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
    expect(workspaceGitignoreEntries(manifest)).toEqual([
      "/.aidlc-workspace-sync-recovery-*/",
      "/.aidlc-workspace-sync-txn-*/",
      "/a/",
      "/nested/d/",
    ]);
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

  test("a path written on Windows reads the same on every platform", () => {
    const { root, ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "checkout-api", path: "..\\..\\checkout-api" }] }));
    expect(repoDir(ws, "checkout-api")).toBe(join(root, "checkout-api"));
  });

  test("one person's repos.local.json overrides path for a listed repo; an unlisted name is one line and ignored", () => {
    const { root, ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../billing" }] }));
    mkdirSync(join(ws, "aidlc"), { recursive: true });
    writeFileSync(join(ws, "aidlc", "repos.local.json"), JSON.stringify({
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
      "billing is not at ../billing, where repos.json puts it. Clone it there, or give its path in aidlc/repos.local.json.",
    );
    expect(repoNotThereLine(ws, "web")).toBe(
      "web is not at web in this workspace. Clone it there, or give its path in aidlc/repos.local.json.",
    );
    expect(repoNotThereLine(ws, "ghost")).toBe(
      "ghost is not at ghost in this workspace. Clone it there, or list it in repos.json with its path.",
    );
  });
});

// The first /aidlc scans for code: a workspace whose repos.json puts its repos
// beside it (decision 17's layout) has code, however empty its own folder is.
describe("the workspace scan reads the repos repos.json names", () => {
  function codeAt(dir: string): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { express: "^4.0.0" } }));
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  }

  test("repos outside the workspace with code: Brownfield, their languages counted", () => {
    const { root, ws } = layout();
    for (const name of ["api", "web"]) codeAt(join(root, "work", name));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", path: "../api" }, { name: "web", path: "../web" }] }));
    const scan = detectWorkspace(ws);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.languages).toContain("TypeScript");
  });

  // RFC scenario 2: one big repo beside the workspace, its code in folders
  // below its root, read as deep as the same repo inside the workspace is.
  test("one big repo beside the workspace, code only in its services and apps: Brownfield", () => {
    const { root, ws } = layout();
    const platform = join(root, "work", "platform");
    for (const sub of [["services", "orders"], ["services", "billing"], ["apps", "web"]]) codeAt(join(platform, ...sub));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "platform", path: "../platform" }] }));
    const scan = detectWorkspace(ws);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.nestedRoot).toBeUndefined();
  });

  test("a repos.json path with no code there, or no repos.json: the folder alone decides, as before", () => {
    const { root, ws } = layout();
    mkdirSync(join(root, "work", "api"), { recursive: true });
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", path: "../api" }] }));
    expect(detectWorkspace(ws).projectType).toBe("Greenfield");
    const other = layout();
    codeAt(join(other.root, "work", "api"));
    expect(detectWorkspace(other.ws).projectType).toBe("Greenfield");
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

  test("the source list a line names for a mapped repo is the one in that repo's own folder", () => {
    const { root, ws } = layout();
    repoAt(join(root, "billing"));
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../../billing" }, { name: "api" }, { name: "ws", path: "." }] }));
    expect(sourceKeyRegistryFiles(ws, [sourcePathKey("billing", "src/refund.ts")])).toEqual(["../../billing/.aidlc-source-paths.json"]);
    expect(sourceKeyRegistryFiles(ws, [sourcePathKey("api", "src/x.ts")])).toEqual(["api/.aidlc-source-paths.json"]);
    expect(sourceKeyRegistryFiles(ws, [sourcePathKey("ws", "src/x.ts")])).toEqual([".aidlc-source-paths.json"]);
  });

  test("a traceability target in a mapped repo is spelled <repo>/<path> and resolves there", () => {
    const { root, ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", path: "../../billing" }] }));
    expect(workspaceTargetPath(ws, "billing/src/refund.ts")).toBe(join(root, "billing", "src", "refund.ts"));
    expect(workspaceTargetPath(ws, "src/x.ts")).toBe(join(ws, "src", "x.ts"));
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
    mkdirSync(join(ws, "aidlc"), { recursive: true });
    writeFileSync(join(ws, "aidlc", "repos.local.json"), JSON.stringify({ repos: [{ name: "billing", path: join(root, "src", "billing") }] }));
    const result = sync(ws);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(root, "src", "billing", ".git"))).toBe(true);
    expect(existsSync(join(root, "work", "billing"))).toBe(false);
  });

  test("a blank url is not cloned, and one line names how to add a url", () => {
    const { ws } = layout();
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: "", path: "../billing" }] }));
    const result = sync(ws);
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain(
      "billing is not at ../billing, where repos.json puts it. Clone it there, or give its path in aidlc/repos.local.json. " +
        'repos.json gives it no "url" to clone it from: add its "url" in repos.json, or in aidlc/repos.local.json for your own copy.',
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

// A staging folder beside a checkout outside the workspace that is still there
// after a run: said once, after the run's own line, with where it is; never
// removed by AI-DLC when it did not just make it.
describe("a staging folder left beside a checkout outside the workspace", () => {
  const leftLine = (dir: string, repo: string): string =>
    `AI-DLC could not remove the temporary folder ${dir} it made to clone ${repo}; nothing in it is needed, so you can delete it.`;

  test("a removal that fails is said once, and the folder is kept", () => {
    const { root } = layout();
    const dir = join(root, ".aidlc-workspace-sync-clone-billing-Ab12Cd");
    mkdirSync(dir);
    removeOutsideStages([{ dir, repo: "billing" }], () => {
      throw new Error("EBUSY: resource busy or locked");
    });
    expect(takeStagingLeftLines()).toEqual([leftLine(dir, "billing")]);
    expect(takeStagingLeftLines()).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("one an earlier run left is said by the next workspace-sync of that repo, after its result, and kept", () => {
    const { root, ws } = layout();
    const bare = bareWithCommit(root, "billing");
    const left = join(root, "work", ".aidlc-workspace-sync-clone-billing-Ab12Cd");
    mkdirSync(join(left, "billing"), { recursive: true });
    writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: bare, path: "../billing" }] }));
    const result = sync(ws);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(root, "work", "billing", ".git"))).toBe(true);
    const said = leftLine(left, "billing");
    expect(result.out.split(said).length - 1, result.out).toBe(1);
    expect(existsSync(left)).toBe(true);
  });

  // A folder the person can make things in but not list (write and search with
  // no read) took clones before the look for an earlier run's folder; the look
  // never stops one.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a destination folder that cannot be listed still takes the clone, and nothing is said",
    () => {
      const { root, ws } = layout();
      const bare = bareWithCommit(root, "billing");
      const away = join(root, "away");
      mkdirSync(away);
      chmodSync(away, 0o300);
      try {
        writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: bare, path: "../../away/billing" }] }));
        const result = sync(ws);
        expect(result.status, result.out).toBe(0);
        expect(existsSync(join(away, "billing", ".git"))).toBe(true);
        expect(result.out).not.toContain("AI-DLC could not remove the temporary folder");
      } finally {
        chmodSync(away, 0o755);
      }
    },
  );

  // A file git cannot let go of: the clone's own hook leaves a folder only its
  // owner can open up, then fails the clone. chmod does not lock a file on
  // Windows, and root opens any folder.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a clone that fails and leaves a folder that cannot be removed: the line comes after the failure, and the folder stays",
    () => {
      const { root, ws } = layout();
      const bare = bareWithCommit(root, "billing");
      const template = join(root, "template");
      mkdirSync(join(template, "hooks"), { recursive: true });
      writeFileSync(join(template, "hooks", "post-checkout"), "#!/bin/sh\nmkdir -p held && echo x > held/f && chmod 555 held\nexit 1\n", {
        mode: 0o755,
      });
      writeFileSync(join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "billing", url: bare, path: "../billing" }] }));
      const result = spawnSync(BUN, [SYNC, "--project-dir", ws], {
        cwd: ws,
        encoding: "utf-8",
        env: { ...GIT_ENV, GIT_TEMPLATE_DIR: template },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      const stage = readdirSync(join(root, "work")).find((name) => name.startsWith(".aidlc-workspace-sync-clone-billing-"));
      try {
        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(stage, readdirSync(join(root, "work")).join(", ")).toBeDefined();
        const said = leftLine(join(root, "work", stage ?? ""), "billing");
        expect(result.stderr.split(said).length - 1, result.stderr).toBe(1);
        expect(result.stderr.indexOf(said)).toBeGreaterThan(result.stderr.indexOf("✗"));
      } finally {
        const held = join(root, "work", stage ?? "", "billing", "held");
        if (stage !== undefined && existsSync(held)) chmodSync(held, 0o755);
      }
    },
  );
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

// One person's work over two child repos in Construction, built one Unit at a
// time: the walk's cursor stays on the first per-Unit stage throughout, the
// first Unit (u1-tracker-core) built through every per-Unit stage and the
// second (u2-tracker-cli) not begun.
const WALK = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
function walkProject(): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  const units = ["u1-tracker-core", "u2-tracker-cli"];
  const row = (slug: string): string => `- [${slug === WALK[0] ? "-" : " "}] ${slug} ${D} EXECUTE`;
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: repos anywhere walk test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
${WALK.map(row).join("\n")}
- [ ] build-and-test ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(proj, units);
  const graph = loadStageGraph();
  const cover = (unit: string, slug: string): void => {
    const dir = join(seededRecordDir(proj), "construction", unit, slug);
    mkdirSync(dir, { recursive: true });
    for (const name of graph.find((stage) => stage.slug === slug)?.produces ?? []) {
      writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
    }
  };
  for (const slug of WALK) cover(units[0], slug);
  for (const name of ["tracker-core", "tracker-cli"]) repoAt(join(proj, name));
  const registryPath = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
  registry[0].repos = ["tracker-core", "tracker-cli"];
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  git(proj, ["init", "-q", "-b", "main"]);
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

function utility(proj: string, args: string[], env: NodeJS.ProcessEnv = ENV): { rc: number; out: string } {
  const result = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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

  // A live run: a one-repo project holding a git submodule, teams chosen; the
  // submodule comes with every clone of the workspace, yet the offer named it.
  test("a project's own submodule is no repo besides the workspace: teams on the project are never offered it", () => {
    const proj = boundaryProject([]);
    writeFileSync(seededStateFile(proj), boundaryState().replace("## Scope Configuration", "## Runtime State\n- **Unit Ownership**: team\n\n## Scope Configuration"));
    repoAt(join(proj, "shared-utils"));
    writeFileSync(join(proj, ".gitmodules"), '[submodule "shared-utils"]\n\tpath = shared-utils\n\turl = ../shared-utils\n');
    const step = next(proj);
    expect(step.ask_type ?? null, JSON.stringify(step).slice(0, 400)).not.toBe("repos-manifest");
  });

  test("work that records repos is offered it too when one person builds it, or teams build it with no home recorded", () => {
    expect(next(boundaryProject(["checkout-api", "checkout-web"], false)).ask_type).toBe("repos-manifest");
    const today = boundaryProject(["checkout-api", "checkout-web"], false);
    writeFileSync(seededStateFile(today), boundaryState().replace("## Scope Configuration", "## Runtime State\n- **Unit Ownership**: team\n\n## Scope Configuration"));
    expect(next(today).ask_type).toBe("repos-manifest");
  });

  test("one person's work on one repo inside the workspace is never offered it; two repos, or teams, are", () => {
    // One person, one repo (a scaffolder's folder with its own git): no teammate needs the list.
    const alone = boundaryProject(["lunch-poll"], false);
    const step = next(alone);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
    expect(next(boundaryProject(["lunch-poll"], true)).ask_type).toBe("repos-manifest");
    expect(next(boundaryProject(["lunch-poll", "lunch-api"], false)).ask_type).toBe("repos-manifest");
  });

  test("a workspace that already has repos.json is never offered it", () => {
    const proj = boundaryProject(["checkout-api", "checkout-web"]);
    writeFileSync(join(proj, "repos.json"), JSON.stringify({ repos: [{ name: "checkout-api" }, { name: "checkout-web" }] }));
    const step = next(proj);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
  });

  // x2783-f8: one person's work over two child repos, no repos.json, the
  // workspace a checkout of its own. A Unit's code put a file at the workspace
  // root, so the agent added the workspace itself by its folder; that wrote a
  // repos.json listing only the workspace. The offer to list the repos found
  // here still comes, once, and adds them to that file.
  test("the workspace itself added by its folder leaves the offer to list the repos found here, which adds them", () => {
    const proj = boundaryProject(["tracker-core", "tracker-cli"], false);
    git(proj, ["init", "-q", "-b", "main"]);
    const added = utility(proj, ["intent", "add-repo", "habits", "--path", "."]);
    expect(added.rc, added.out).toBe(0);
    expect(JSON.parse(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8"))).toEqual({ repos: [{ name: "habits", path: "." }] });
    expect(added.out).toContain("repos.json is new: it lists habits as the workspace folder itself. Commit it to share it with your team.");
    const ask = next(proj);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("repos-manifest");
    expect(ask.question).toBe(
      "Add the 2 repos found here (tracker-cli, tracker-core) to repos.json? It lists each one's folder and " +
        "the address its origin points to, so a teammate's clone knows where they go.",
    );
    const written = sync(proj, ["--write-manifest"]);
    expect(written.status, written.out).toBe(0);
    expect(JSON.parse(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8")).repos).toEqual([
      { name: "habits", path: "." },
      { name: "tracker-cli", url: "", path: "tracker-cli" },
      { name: "tracker-core", url: "", path: "tracker-core" },
    ]);
    const after = next(proj);
    expect(after.ask_type, JSON.stringify(after)).not.toBe("repos-manifest");
  });

  // Only the add's own file: a repos.json the person wrote, or changed after
  // the add, is theirs, and the offer stands back for it as it always has.
  test("a repos.json the person wrote listing only the workspace, or changed after the add, is never offered it", () => {
    const own = boundaryProject(["tracker-core", "tracker-cli"], false);
    git(own, ["init", "-q", "-b", "main"]);
    const raw = `${JSON.stringify({ repos: [{ name: "habits", path: "." }] }, null, 2)}\n`;
    writeFileSync(join(own, "repos.json"), raw);
    const step = next(own);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
    const kept = sync(own, ["--write-manifest"]);
    expect(kept.out).toContain("repos.json is already here; nothing was written.");
    expect(readFileSync(join(own, "repos.json"), "utf-8")).toBe(raw);

    const changed = boundaryProject(["tracker-core", "tracker-cli"], false);
    git(changed, ["init", "-q", "-b", "main"]);
    expect(utility(changed, ["intent", "add-repo", "habits", "--path", "."]).rc).toBe(0);
    writeFileSync(join(changed, "aidlc", "repos.json"), `// ours\n${readFileSync(join(changed, "aidlc", "repos.json"), "utf-8")}`);
    const later = next(changed);
    expect(later.ask_type, JSON.stringify(later)).not.toBe("repos-manifest");
  });

  test("with a chat, the line about the repos.json the add wrote rides the next step the agent speaks from", () => {
    const proj = boundaryProject(["tracker-core", "tracker-cli"], false);
    git(proj, ["init", "-q", "-b", "main"]);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: SESSION };
    for (const key of ["AIDLC_SESSION_OVERRIDE_SOURCE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID"]) delete chat[key];
    const added = utility(proj, ["intent", "add-repo", "habits", "--path", "."], chat);
    expect(added.rc, added.out).toBe(0);
    expect(added.out).not.toContain("repos.json is new");
    const step = runOrchestrateNext(ORCH, proj, [], { env: chat }).directive;
    expect((step?.change_notices as string[] | undefined) ?? [], JSON.stringify(step)).toContain(
      "repos.json is new: it lists habits as the workspace folder itself. Commit it to share it with your team.",
    );
  });

  test("the person's own approval moves the work on: the next step makes the offer once, then never again", async () => {
    // The Requirements Analysis gate open as a run leaves it, in a workspace with two repos the work records.
    const proj = await projectAt("stage-gate");
    projects.push(proj);
    for (const name of ["checkout-api", "checkout-web"]) repoAt(join(proj, name));
    const registryPath = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = ["checkout-api", "checkout-web"];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    expect((await say(proj, "Approve", "claude")).status).toBe(0);
    const approved = await exec(
      [BUN, ORCH, "report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve", "--project-dir", proj],
      { cwd: proj, env: runEnv(proj, { env: { AIDLC_DISABLE_SENSORS: "1", AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", AIDLC_SKIP_REVIEWER_GATE_GUARD: "1" } }) },
    );
    expect(approved.status, approved.stdout + approved.stderr).toBe(0);
    const ask = (await liveNext(proj, [])).directive;
    expect(ask?.ask_type, JSON.stringify(ask)).toBe("repos-manifest");
    expect(ask?.question).toStartWith("Write repos.json from the 2 repos found here (checkout-api, checkout-web)?");
    const after = (await liveNext(proj, [])).directive;
    expect(after?.ask_type, JSON.stringify(after)).not.toBe("repos-manifest");
    expect(after?.kind).toBe("run-stage");
  });

  // x2783-f8 F1 re-check: the add came at the second Unit's start, in a walk
  // that builds one Unit at a time, and the offer waited for Build and Test,
  // after the whole of that Unit. The next Unit's first step of a stage is a
  // boundary as a stage's first step is; a step in the middle of one is not.
  test("in a walk that builds one Unit at a time, the next Unit's first step is a stage boundary for the offer", () => {
    const proj = walkProject();
    const added = utility(proj, ["intent", "add-repo", "habits", "--path", "."]);
    expect(added.rc, added.out).toBe(0);
    const ask = next(proj);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("repos-manifest");
    expect(ask.question).toStartWith("Add the 2 repos found here (tracker-cli, tracker-core) to repos.json?");
    const step = next(proj);
    expect(step.ask_type ?? null, JSON.stringify(step).slice(0, 600)).not.toBe("repos-manifest");
    expect([step.kind, step.stage, step.unit]).toEqual(["run-stage", "functional-design", "u2-tracker-cli"]);
  });

  test("a Unit's step already under way is never interrupted by the offer", () => {
    const begun = walkProject();
    expect(utility(begun, ["intent", "add-repo", "habits", "--path", "."]).rc).toBe(0);
    const questions = join(seededRecordDir(begun), "construction", "u2-tracker-cli", "functional-design");
    mkdirSync(questions, { recursive: true });
    writeFileSync(join(questions, "functional-design-questions.md"), "# Questions\n");
    const step = next(begun);
    expect(step.ask_type ?? null, JSON.stringify(step).slice(0, 600)).not.toBe("repos-manifest");
    expect([step.kind, step.stage, step.unit]).toEqual(["run-stage", "functional-design", "u2-tracker-cli"]);
  });

  test("an unattended run is never offered it", () => {
    const proj = boundaryProject(["checkout-api", "checkout-web"]);
    const result = runOrchestrateNext(ORCH, proj, [], { env: { ...ENV, AIDLC_UNATTENDED: "1" } });
    expect(result.directive?.ask_type, result.out).not.toBe("repos-manifest");
  });
});
