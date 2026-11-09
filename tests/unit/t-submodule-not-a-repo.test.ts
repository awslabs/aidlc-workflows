// covers: subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:reclassify, cli:aidlc-utility(intent remove-repo), function:startingRepoSet, function:detectWorkspace, function:handleIntentRepos
//
// A project with code of its own that holds a git submodule (a shared library
// it never changes) is a one-repo project: when work starts, the project folder
// is the work's repo and the submodule is not recorded. A project whose code
// lives only in its submodules records them, as does a person who names one
// (`--repos`). Whether the project has code of its own is the workspace scan's
// own verdict, read with the folders `.gitmodules` lists left out. Removing a
// submodule the work records is never refused when the project folder would be
// left as the repo.
//
// Mechanism: cli. The shipped tools (dist/claude) run against temp projects
// whose submodules are real `git submodule add` checkouts of local bare repos.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

// Git as the person runs it, without this machine's own git config.
const gitHome = mkdtempSync(join(tmpdir(), "aidlc-submodule-git-"));
tempDirs.push(gitHome);
const gitConfig = join(gitHome, "gitconfig");
writeFileSync(gitConfig, "");
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", [
    "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args,
  ], { encoding: "utf-8", env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

let origins = 0;
// A bare repo with one commit of `files`, as a team's shared library lives.
function origin(files: Record<string, string>, submodules: Record<string, string> = {}): string {
  const work = join(gitHome, "work", String(++origins));
  mkdirSync(work, { recursive: true });
  write(work, files);
  git(work, ["init", "-q"]);
  for (const [path, url] of Object.entries(submodules)) git(work, ["submodule", "add", "-q", url, path]);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "seed"]);
  const bare = join(gitHome, "remotes", `${origins}.git`);
  mkdirSync(join(gitHome, "remotes"), { recursive: true });
  const r = spawnSync("git", ["clone", "-q", "--bare", work, bare], { encoding: "utf-8", env: gitEnv });
  if (r.status !== 0) throw new Error(`git clone --bare failed: ${r.stderr}`);
  // Forward slashes: .gitmodules keeps the address as given, and git reads them on Windows too.
  return bare.replaceAll("\\", "/");
}

const LIBRARY = {
  "package.json": JSON.stringify({ name: "shared-utils", dependencies: { lodash: "4.17.21" } }),
  "src/index.ts": "export const slug = (s: string) => s.toLowerCase();\n",
};
const OWN_CODE = {
  "package.json": JSON.stringify({ name: "tally", devDependencies: { "@types/bun": "latest" } }),
  "src/tasks.ts": "export const tasks: string[] = [];\n",
};
const ONLY_SUBMODULES = {
  "README.md": "# Our services\n\nEach service is a submodule.\n",
  ".gitignore": "node_modules/\n",
};

// A git project holding `files` and a submodule of the library at each path,
// committed, the way `git submodule add` leaves it.
function project(files: Record<string, string>, paths: string[] = ["shared-utils"], library = origin(LIBRARY)): string {
  const proj = createOrchestrationTestProject();
  tempDirs.push(proj);
  write(proj, files);
  git(proj, ["init", "-q"]);
  for (const path of paths) git(proj, ["submodule", "add", "-q", library, path]);
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "seed"]);
  return proj;
}

// A refusal prints {"error": "..."}: its text is read the way it is said.
function run(proj: string, args: string[]): { rc: number; out: string } {
  const r = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: gitEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").map((line) => {
    try {
      const value = JSON.parse(line) as { error?: unknown };
      return typeof value?.error === "string" ? value.error : line;
    } catch {
      return line;
    }
  }).join("\n");
  return { rc: r.status ?? -1, out };
}

function create(proj: string, extra: string[] = []): void {
  const r = run(proj, ["intent-create", "--scope", "classic", "--arguments", "add a done command", ...extra]);
  expect(r.rc, r.out).toBe(0);
}

function activeRecord(proj: string): { intents: string; dirName: string } {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return { intents, dirName: readFileSync(join(intents, "active-intent"), "utf-8").trim() };
}

// The registry row of the work this test started.
function row(proj: string): { repos?: string[]; repos_named?: boolean } {
  const { intents, dirName } = activeRecord(proj);
  const rows = JSON.parse(readFileSync(join(intents, "intents.json"), "utf-8")) as Array<{
    dirName?: string;
    repos?: string[];
    repos_named?: boolean;
  }>;
  const found = rows.find((entry) => entry.dirName === dirName);
  expect(found, dirName).toBeDefined();
  return found!;
}

function audit(proj: string): string {
  const { intents, dirName } = activeRecord(proj);
  const dir = join(intents, dirName, "audit");
  return existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf-8")).join("\n") : "";
}

describe("t-submodule-not-a-repo: the repos work records when it starts", () => {
  test("a project with code of its own is the work's repo; its submodule is not recorded", () => {
    const proj = project(OWN_CODE);
    expect(existsSync(join(proj, "shared-utils", ".git"))).toBe(true);
    create(proj);
    expect(row(proj).repos ?? []).toEqual([]);
    expect(audit(proj)).not.toContain("**Repos**:");
  });

  test("a person who names the submodule gets it recorded", () => {
    const proj = project(OWN_CODE);
    create(proj, ["--repos", "shared-utils"]);
    expect(row(proj).repos).toEqual(["shared-utils"]);
    expect(row(proj).repos_named).toBe(true);
  });

  test("a project made only of submodules records them, as it always has", () => {
    const proj = project(ONLY_SUBMODULES, ["orders", "shared-utils"]);
    create(proj);
    expect(row(proj).repos).toEqual(["orders", "shared-utils"]);
  });

  test("nested submodules: the library's own submodule changes nothing either way", () => {
    const library = origin(LIBRARY, { "vendor/strings": origin({ "src/strings.ts": "export const s = 1;\n" }) });
    const own = project(OWN_CODE, ["shared-utils"], library);
    git(own, ["submodule", "update", "--init", "--recursive", "-q"]);
    expect(existsSync(join(own, "shared-utils", "vendor", "strings", ".git"))).toBe(true);
    create(own);
    expect(row(own).repos ?? []).toEqual([]);

    const only = project(ONLY_SUBMODULES, ["shared-utils"], library);
    git(only, ["submodule", "update", "--init", "--recursive", "-q"]);
    create(only);
    expect(row(only).repos).toEqual(["shared-utils"]);
  });

  test("code of its own in a nested folder counts, as the scan reads it", () => {
    const proj = project({
      "README.md": "# Monorepo\n",
      "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }),
      "packages/app/package.json": JSON.stringify({ name: "app", dependencies: { express: "4.0.0" } }),
      "packages/app/index.js": "module.exports = 1;\n",
    });
    create(proj);
    expect(row(proj).repos ?? []).toEqual([]);
  });

  test("a submodule at lib/ is not the project's own source folder", () => {
    const beside = project({ ...OWN_CODE }, ["lib"]);
    create(beside);
    expect(row(beside).repos ?? []).toEqual([]);

    const alone = project(ONLY_SUBMODULES, ["lib"]);
    create(alone);
    expect(row(alone).repos).toEqual(["lib"]);
  });

  test("a .gitmodules with CRLF line ends, a trailing slash or a Windows path reads the same", () => {
    for (const written of ["shared-utils/", ".\\shared-utils\\"]) {
      const proj = project(OWN_CODE);
      const listed = readFileSync(join(proj, ".gitmodules"), "utf-8");
      writeFileSync(
        join(proj, ".gitmodules"),
        listed.replace("path = shared-utils", `path = ${written}`).replace(/\r?\n/g, "\r\n"),
      );
      create(proj);
      expect(row(proj).repos ?? [], written).toEqual([]);
    }
  });

  test("code in a clone beside the submodule is that clone's, not the project's own", () => {
    const proj = project(ONLY_SUBMODULES);
    write(join(proj, "api"), OWN_CODE);
    git(join(proj, "api"), ["init", "-q"]);
    git(join(proj, "api"), ["add", "-A"]);
    git(join(proj, "api"), ["commit", "-qm", "seed"]);
    create(proj);
    expect(row(proj).repos).toEqual(["api", "shared-utils"]);
  });

  test("existing code declared after a new-project start records no submodule", () => {
    const proj = createOrchestrationTestProject();
    tempDirs.push(proj);
    create(proj);
    expect(row(proj).repos ?? []).toEqual([]);
    write(proj, OWN_CODE);
    git(proj, ["init", "-q"]);
    git(proj, ["submodule", "add", "-q", origin(LIBRARY), "shared-utils"]);
    // What the folder is, is the person's word: here they have just said it.
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const r = run(proj, ["reclassify", "--project-type", "brownfield"]);
    expect(r.rc, r.out).toBe(0);
    expect(row(proj).repos ?? []).toEqual([]);
    expect(audit(proj)).not.toContain("**Repos Recorded**");
  });
});

describe("t-submodule-not-a-repo: removing a submodule from the work", () => {
  test("the last repo goes when it is a submodule: the project folder is the work's repo again", () => {
    const proj = project(OWN_CODE);
    // Work an earlier build started, which recorded the submodule.
    create(proj, ["--repos", "shared-utils"]);
    const r = run(proj, ["intent", "remove-repo", "shared-utils", "--person-words", "it's only this repo"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out.trim()).toBe(
      "Removed shared-utils from this piece of work's repos; it now works on the workspace folder itself. Its folder stays.",
    );
    expect(row(proj).repos ?? []).toEqual([]);
    expect(audit(proj)).toContain("**Removed**: shared-utils");
    expect(existsSync(join(proj, "shared-utils", ".git"))).toBe(true);
  });

  test("on work that records no repos, removing one changes nothing and refuses nothing", () => {
    const proj = project(OWN_CODE);
    create(proj);
    const r = run(proj, ["intent", "remove-repo", "shared-utils"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out.trim()).toBe("This piece of work records no repos: it works on the workspace folder itself. Nothing changed.");
    expect(audit(proj)).not.toContain("INTENT_REPOS_CHANGED");
  });

  test("a last repo that is no submodule of the project is still kept", () => {
    const proj = createOrchestrationTestProject();
    tempDirs.push(proj);
    write(join(proj, "api"), OWN_CODE);
    git(join(proj, "api"), ["init", "-q"]);
    git(join(proj, "api"), ["add", "-A"]);
    git(join(proj, "api"), ["commit", "-qm", "seed"]);
    create(proj);
    expect(row(proj).repos).toEqual(["api"]);
    const r = run(proj, ["intent", "remove-repo", "api"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("\"api\" is the only repo this piece of work records; removing it would leave none.");
    expect(row(proj).repos).toEqual(["api"]);
  });

  test("the command's help and its one-line summaries do not say the last repo is never removed", () => {
    const proj = createOrchestrationTestProject();
    tempDirs.push(proj);
    const help = run(proj, ["help"]).out.split("\n").filter((line) => line.includes("intent remove-repo"));
    expect(help).toHaveLength(1);
    expect(help[0]).not.toContain("never the last");
    const docs = join(import.meta.dir, "..", "..", "docs");
    const summary = readFileSync(join(docs, "guide", "12-cli-commands.md"), "utf-8").split("\n")
      .filter((line) => line.startsWith("| `/aidlc intent add-repo"));
    expect(summary).toHaveLength(1);
    expect(summary[0]).not.toContain("never the last");
    const toolRow = readFileSync(join(docs, "reference", "06-hooks-and-tools.md"), "utf-8").split("\n")
      .filter((line) => line.startsWith("| `intent remove-repo"));
    expect(toolRow).toHaveLength(1);
    expect(toolRow[0]).toContain("unless it is a git submodule of the project");
  });
});
