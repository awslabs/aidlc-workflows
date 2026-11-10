// covers: function:readUnitSourceManifest
//
// A write in a recorded repo names its path from that repo's root. A path the
// repo does not have and never had (most often one given from the workspace,
// {repo: "billing", path: "billing/package.json"}) binds no file to the
// review, so the read fails with one reason naming every such write; a real
// deletion still reads as one, and a workspace that is its own repo or a Bolt's
// worktree reads as before. Work that records the project's own git submodule
// as its only repo (as work started before a project's own submodule stopped
// being recorded did) while the Unit's code is the project's own names the way
// on: the person is asked once whether to take the submodule off the work's
// repos (remove-repo), or the code goes in the submodule.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnitSourceManifest, sourceClaimCovers } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { aidlcDispatcherInvocation } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

// A workspace with these recorded repos (none: the workspace is its own repo),
// each a git repo holding package.json and src/app.ts at its root.
function workspace(repos: string[]): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-manifest-root-"));
  dirs.push(project);
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  const record = join(intents, "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), "# State\n- **Scope**: feature\n");
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos }])}\n`);
  writeFileSync(join(intents, ".active-intent"), "fixture-intent\n");
  for (const dir of repos.length === 0 ? [project] : repos.map((repo) => join(project, repo))) {
    mkdirSync(join(dir, "src"), { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@test"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    commitAll(dir, "seed");
  }
  return { project, record };
}

function writeManifest(record: string, writes: unknown[], eol = "\n"): void {
  const dir = join(record, "construction", "alpha", "code-generation");
  mkdirSync(dir, { recursive: true });
  const text = JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes }, null, 2);
  writeFileSync(join(dir, "source-manifest.json"), `${text.replaceAll("\n", eol)}${eol}`);
}

function read(project: string, options = {}) {
  return readUnitSourceManifest(project, "code-generation", "alpha", options);
}

describe("a recorded repo's write names its path from the repo's root", () => {
  test("a path given from the workspace is refused with the path from the repo's root", () => {
    const { project, record } = workspace(["billing", "web"]);
    writeManifest(record, [{ repo: "billing", path: "billing/package.json" }]);
    const result = read(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'writes[0].path "billing/package.json" is not in repo "billing" or its git history (from that repo\'s root: "package.json"). ' +
        "Give each write's path from its repo's root, or leave out a path this Unit did not change",
    );
  });

  test("every bad write is named in the one reason, in the manifest's order", () => {
    const { project, record } = workspace(["billing", "web"]);
    writeManifest(record, [
      { repo: "billing", path: "billing/src/" },
      { repo: "billing", path: "package.json" },
      { repo: "web", path: "web/src/app.ts" },
      { repo: "web", path: "lib/missing.ts" },
    ]);
    const result = read(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'writes[0].path "billing/src/" is not in repo "billing" or its git history (from that repo\'s root: "src/"); ' +
        'writes[2].path "web/src/app.ts" is not in repo "web" or its git history (from that repo\'s root: "src/app.ts"); ' +
        'writes[3].path "lib/missing.ts" is not in repo "web" or its git history. ' +
        "Give each write's path from its repo's root, or leave out a path this Unit did not change",
    );
  });

  test("a write with no repo in work that records one repo is read in that repo the same way", () => {
    const { project, record } = workspace(["billing"]);
    writeManifest(record, [{ path: "billing/package.json" }]);
    const refused = read(project);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('is not in repo "billing" or its git history (from that repo\'s root: "package.json")');
    writeManifest(record, [{ path: "package.json" }]);
    expect(read(project).ok).toBe(true);
  });

  test("a repo that keeps a folder of its own name still refuses the path given from the workspace", () => {
    const { project, record } = workspace(["billing", "web"]);
    const billing = join(project, "billing");
    mkdirSync(join(billing, "billing"));
    writeFileSync(join(billing, "billing", "__init__.py"), "");
    writeFileSync(join(billing, "setup.py"), "");
    commitAll(billing, "package");
    writeManifest(record, [{ repo: "billing", path: "billing/setup.py" }]);
    const refused = read(project);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('(from that repo\'s root: "setup.py")');
    // An untracked file removed from that folder is still a deletion.
    writeManifest(record, [{ repo: "billing", path: "billing/scratch.py" }]);
    expect(read(project).ok).toBe(true);
  });

  test("the path from the repo's root binds the real file", () => {
    const { project, record } = workspace(["billing", "web"]);
    writeManifest(record, [{ repo: "billing", path: "package.json" }, { repo: "web", path: "src/" }]);
    const result = read(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sourceClaimCovers("billing\0package.json", result)).toBe(true);
    expect(sourceClaimCovers("web\0src/app.ts", result)).toBe(true);
  });

  test("a real deletion still reads as one", () => {
    const { project, record } = workspace(["billing", "web"]);
    const billing = join(project, "billing");
    const web = join(project, "web");
    // Gone from the working tree, still at HEAD.
    unlinkSync(join(billing, "package.json"));
    // Staged as a delete.
    git(billing, ["rm", "-q", "src/app.ts"]);
    // A folder removed and its delete committed.
    git(web, ["rm", "-q", "-r", "src"]);
    git(web, ["commit", "-qm", "drop src"]);
    // An untracked file removed from a folder still on disk.
    mkdirSync(join(web, "lib"));
    writeFileSync(join(web, "lib", "keep.ts"), "export {};\n");
    writeManifest(record, [
      { repo: "billing", path: "package.json" },
      { repo: "billing", path: "src/app.ts" },
      { repo: "web", path: "src/" },
      { repo: "web", path: "src/app.ts" },
      { repo: "web", path: "lib/scratch.ts" },
    ]);
    expect(read(project).ok).toBe(true);
  });

  test("a CRLF manifest is read the same way", () => {
    const { project, record } = workspace(["billing", "web"]);
    writeManifest(record, [{ repo: "billing", path: "billing/package.json" }], "\r\n");
    const refused = read(project);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('(from that repo\'s root: "package.json")');
    writeManifest(record, [{ repo: "billing", path: "package.json" }], "\r\n");
    expect(read(project).ok).toBe(true);
  });

  test("a backslash path is refused as before, naming the separator", () => {
    const { project, record } = workspace(["billing", "web"]);
    writeManifest(record, [{ repo: "billing", path: "billing\\package.json" }]);
    const result = read(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must use POSIX '/' separators");
  });

  test.if(process.platform === "win32")("a project path with the other drive-letter case reads the same", () => {
    const { project, record } = workspace(["billing", "web"]);
    const flipped = /^[a-z]:/.test(project) ? project[0].toUpperCase() + project.slice(1) : project[0].toLowerCase() + project.slice(1);
    writeManifest(record, [{ repo: "billing", path: "billing/package.json" }]);
    const refused = read(flipped);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('(from that repo\'s root: "package.json")');
    writeManifest(record, [{ repo: "billing", path: "package.json" }]);
    expect(read(flipped).ok).toBe(true);
  });

  test("a workspace that is its own repo reads a path it never had as before", () => {
    const { project, record } = workspace([]);
    writeManifest(record, [{ path: "package.json" }, { path: "gone/never.ts" }]);
    expect(read(project).ok).toBe(true);
  });

  test("a Bolt's worktree reads a path it never had as before", () => {
    const { project, record } = workspace([]);
    writeManifest(record, [{ path: "billing/package.json" }]);
    expect(read(project, { worktreeRelative: true }).ok).toBe(true);
  });
});

// The work's recorded repos, as its registry row keeps them.
function recordRepos(project: string, repos: string[]): void {
  const path = join(project, "aidlc", "spaces", "default", "intents", "intents.json");
  const rows = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>;
  writeFileSync(path, `${JSON.stringify(rows.map((row) => ({ ...row, repos })))}\n`);
}

// A project with code of its own (package.json, src/app.ts) holding a library
// at vendor/ (lib/index.ts) added with `git submodule add`, whose work records
// vendor as its only repo, and the Unit's code at src/refunds.ts.
function submoduleWork(): { project: string; record: string } {
  const { project, record } = workspace([]);
  const library = mkdtempSync(join(tmpdir(), "aidlc-manifest-lib-"));
  dirs.push(library);
  mkdirSync(join(library, "lib"));
  writeFileSync(join(library, "lib", "index.ts"), "export const slug = 1;\n");
  git(library, ["init", "-q"]);
  git(library, ["config", "user.email", "t@test"]);
  git(library, ["config", "user.name", "t"]);
  commitAll(library, "seed");
  // Forward slashes: git reads them on Windows too.
  git(project, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", library.replaceAll("\\", "/"), "vendor"]);
  commitAll(project, "vendor");
  recordRepos(project, ["vendor"]);
  writeFileSync(join(project, "src", "refunds.ts"), "export const refunds = 1;\n");
  return { project, record };
}

const TODAY = "Give each write's path from its repo's root, or leave out a path this Unit did not change";

describe("work that records the project's submodule as its only repo", () => {
  test("code in the project's own repo: the read asks once to take the submodule off, or the code goes in it", () => {
    const { project, record } = submoduleWork();
    writeManifest(record, [{ path: "src/refunds.ts" }]);
    const result = read(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'writes[0].path "src/refunds.ts" is not in repo "vendor" or its git history. This work records vendor, a submodule ' +
        "of the project, as its only repo, and that path is in the project's own repo. Ask the person once whether to " +
        "take vendor off this work's repos, so the project's own repo is the work's repo (vendor's folder stays as it is): " +
        `on their yes, run \`${aidlcDispatcherInvocation("intent remove-repo vendor")}\`, and the manifest reads as written; ` +
        "on their no, the Unit's code goes in vendor, each write giving its path from vendor's root",
    );
    expect(result.projectSubmodule).toBe("vendor");
    writeManifest(record, [{ path: "src/refunds.ts" }, { path: "src/" }]);
    const both = read(project);
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.reason).toContain("and those paths are in the project's own repo");
      expect(both.projectSubmodule).toBe("vendor");
    }
    // A file of the project's the Unit deleted is the project's own too.
    unlinkSync(join(project, "src", "app.ts"));
    writeManifest(record, [{ path: "src/refunds.ts" }, { path: "src/app.ts" }]);
    const deleted = read(project);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.projectSubmodule).toBe("vendor");
  });

  test("once the work no longer records the submodule, the same manifest reads and binds the project's file", () => {
    const { project, record } = submoduleWork();
    writeManifest(record, [{ path: "src/refunds.ts" }]);
    recordRepos(project, []);
    const result = read(project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(sourceClaimCovers("\0src/refunds.ts", result)).toBe(true);
  });

  test("a write that is not all the project's own keeps the root-path reason", () => {
    const { project, record } = submoduleWork();
    for (const writes of [
      [{ path: "vendor/lib/index.ts" }],
      [{ path: "src/missing.ts" }],
      [{ path: "src/refunds.ts" }, { path: "lib/index.ts" }],
      [{ repo: "vendor", path: "src/refunds.ts" }],
      [{ path: "vendor/" }],
    ]) {
      writeManifest(record, writes);
      const result = read(project);
      expect(result.ok, JSON.stringify(writes)).toBe(false);
      if (result.ok) continue;
      expect(result.reason, JSON.stringify(writes)).toEndWith(TODAY);
      expect(result.projectSubmodule, JSON.stringify(writes)).toBeUndefined();
    }
  });

  test("a repo inside the project that is no submodule of it keeps the root-path reason", () => {
    const { project, record } = workspace([]);
    const api = join(project, "api");
    mkdirSync(join(api, "lib"), { recursive: true });
    writeFileSync(join(api, "lib", "index.ts"), "export const api = 1;\n");
    git(api, ["init", "-q"]);
    git(api, ["config", "user.email", "t@test"]);
    git(api, ["config", "user.name", "t"]);
    commitAll(api, "seed");
    recordRepos(project, ["api"]);
    writeFileSync(join(project, "src", "refunds.ts"), "export const refunds = 1;\n");
    writeManifest(record, [{ path: "src/refunds.ts" }]);
    const result = read(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toEndWith(TODAY);
    expect(result.projectSubmodule).toBeUndefined();
  });
});
