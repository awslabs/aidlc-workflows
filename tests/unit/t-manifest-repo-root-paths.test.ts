// covers: function:readUnitSourceManifest
//
// A write in a recorded repo names its path from that repo's root. A path the
// repo does not have and never had (most often one given from the workspace,
// {repo: "billing", path: "billing/package.json"}) binds no file to the
// review, so the read fails with one reason naming every such write; a real
// deletion still reads as one, and a workspace that is its own repo or a Bolt's
// worktree reads as before.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnitSourceManifest, sourceClaimCovers } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

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
