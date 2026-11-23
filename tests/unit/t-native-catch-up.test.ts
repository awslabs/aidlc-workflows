// covers: file:core/hooks/aidlc-session-start.ts, function:moveReposManifestIntoAidlc, file:core/tools/aidlc-lifecycle.ts
//
// After `aidlc update`, each project catches up the next time it is opened: a
// native install's hooks run the machine's release, so the first chat's start in
// a project whose harness files an earlier release wrote runs config's refresh
// for it, unattended, every recorded answer kept. The refresh leaves a tracked
// root repos.json where it is, nothing staged; the first reply asks once whether
// to commit the files git tracks that the refresh changed, with the list moved
// into aidlc/, as one commit of their own on the branch, saying how many under
// each folder (in a Unit's build too), and only that yes moves the list, so after
// a no their own next commit carries nothing of it; unattended, on no branch, or
// with a settings file that held the person's uncommitted words, it says so in
// one line for the person to commit instead, with no move; an untracked list
// moves silently, and a folder git does not track or a project not in git says
// nothing. A second start and a later `aidlc config` change nothing. A pinned
// project, a newer stamp, the status line and a tool call's hook are left alone.
// The release comes through a served mirror, as an organisation's would; the
// project's hooks run through the shell Claude Code uses (Git Bash on Windows).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { readWorkspaceRepos, reposManifestPath } from "../../dist/claude/.claude/tools/aidlc-workspace-manifest.ts";
import { FIXTURES_DIR, REPO_ROOT, seededStateFile, seedWorkspaceShell } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { serveReleaseFixture, writeReleaseFixture } from "../harness/release-fixture.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SKIP_REASON = gitBashSkipReason();
const SESSION = "00000000-0000-4000-8000-00000000ca7c";

let root = "";
let shell = "";
let env: NodeJS.ProcessEnv = {};
let earlierTree = "";
let laterTree = "";
const timings: string[] = [];

function sh(cwd: string, command: string, input = "") {
  const r = spawnSync(shell, ["-c", command], {
    cwd,
    encoding: "utf-8",
    env,
    input,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function stampVersion(project: string): string {
  return (JSON.parse(readFileSync(join(project, ".claude", "tools", "data", "aidlc-stamp.json"), "utf-8")) as {
    frameworkVersion: string;
  }).frameworkVersion;
}

function shifted(version: string, by: -1 | 1): string {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  if (by === 1) return `${major}.${minor}.${patch + 1}`;
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`;
}

// This release's native tree stamped as another release.
function stampedTree(version: string): string {
  const dir = realpathSync(mkdtempSync(join(root, "tree-")));
  cpSync(join(REPO_ROOT, "dist-release", "claude"), dir, { recursive: true });
  const stamp = join(dir, ".claude", "tools", "data", "aidlc-stamp.json");
  const value = JSON.parse(readFileSync(stamp, "utf-8")) as Record<string, unknown>;
  writeFileSync(stamp, `${JSON.stringify({ ...value, frameworkVersion: version }, null, 2)}\n`);
  // A second file that release wrote otherwise, so the refresh changes more than the stamp.
  const skill = join(dir, ".claude", "skills", "aidlc", "SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf-8")}\n<!-- ${version} -->\n`);
  // And its own settings.json, which config merges with the project's own.
  const settings = join(dir, ".claude", "settings.json");
  writeFileSync(settings, `${JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf-8")), companyAnnouncements: [`AI-DLC ${version}`] }, null, 2)}\n`);
  return dir;
}

// A Claude Code project set up from `tree`, with a repo list, all committed
// (with `harnessCommitted: false`, all but .claude; with `git: false`, no git).
function project(
  tree: string,
  options: { tracked?: boolean; pin?: boolean; harnessCommitted?: boolean; git?: boolean; subfolder?: boolean } = {},
): string {
  // With `subfolder`, the project is a folder inside its repo, as in a monorepo.
  const repo = realpathSync(mkdtempSync(join(root, "project-")));
  const dir = options.subfolder ? join(repo, "app") : repo;
  if (options.subfolder) mkdirSync(dir);
  if (options.git === false) {
    const configured = sh(dir, `aidlc config --project-dir "${dir.replaceAll("\\", "/")}" --harness claude --mcp none --quiet --from "${tree.replaceAll("\\", "/")}"`);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    writeFileSync(join(dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`);
    return dir;
  }
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "lee"]);
  git(repo, ["config", "user.email", "lee@example.test"]);
  const configured = sh(dir, `aidlc config --project-dir "$P" --harness claude --mcp none --quiet --from "$T"`.replace("$P", dir.replaceAll("\\", "/")).replace("$T", tree.replaceAll("\\", "/")));
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  if (options.pin) {
    const pinned = sh(dir, `aidlc config --pin ${AIDLC_VERSION} --project-dir "${dir.replaceAll("\\", "/")}"`);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);
  }
  git(dir, options.harnessCommitted === false ? ["add", "-A", "--", ".", ":!.claude"] : ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "setup"]);
  writeFileSync(join(dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`);
  if (options.tracked !== false) {
    git(dir, ["add", "repos.json"]);
    git(dir, ["commit", "-q", "-m", "repo list"]);
  }
  return dir;
}

// The catch-up's line for what changed under .claude, as git now shows it, with the offer for later where the
// commit can run once their own git is ready. No move is said: none was made.
function catchUpSaid(dir: string, later = false): string {
  const n = git(dir, ["status", "--porcelain", "-uall", "--", ".claude"]).split("\n").filter(Boolean).length;
  const head = `AI-DLC updated its own files in this project to ${AIDLC_VERSION}: ${n} file${n === 1 ? "" : "s"} under .claude changed`;
  const line = `${head}. ${n === 1 ? "AI-DLC did not commit it." : "AI-DLC did not commit them."}`;
  return later ? `${line} Say when you want me to commit ${n === 1 ? "it" : "them"}.` : line;
}

// The catch-up's question: the update's own commit of the files the refresh changed, on the branch, with the list
// moved into aidlc/ by that commit when git tracks it at the root, with the drafted message after it.
function catchUpAsked(dir: string, moved = true, branch = "main"): string {
  const n = git(dir, ["status", "--porcelain", "-uall", "--", ".claude"]).split("\n").filter(Boolean).length;
  const files = `${n} file${n === 1 ? "" : "s"} under .claude`;
  return `AI-DLC updated its own files in this project to ${AIDLC_VERSION}: ${files} changed${moved ? ", and it now keeps repos.json in aidlc/" : ""}. ` +
    `Want me to commit them on ${branch}, as one commit of their own${moved ? ", and move repos.json into aidlc/ in that commit" : ""}? ` +
    `Nothing is pushed.${moved ? " Teammates need AI-DLC 2.12 or newer to find repos.json there." : ""} I'd use this commit message:`;
}

function hookCommand(dir: string, event: string): string {
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    statusLine?: { command?: string };
  };
  if (event === "statusLine") return settings.statusLine?.command ?? "";
  return settings.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? "";
}

function sessionStart(
  dir: string,
  label: string,
  extra: Record<string, unknown> = {},
): { status: number | null; stdout: string; stderr: string } {
  const payload = { session_id: SESSION, transcript_path: join(dir, "t.jsonl"), cwd: dir, hook_event_name: "SessionStart", source: "startup", ...extra };
  const started = Date.now();
  const r = sh(dir, hookCommand(dir, "SessionStart"), JSON.stringify(payload));
  timings.push(`${label}: ${Date.now() - started} ms`);
  return r;
}

beforeAll(async () => {
  if (SKIP_REASON !== null) return;
  shell = process.platform === "win32" ? gitBashPath() : "/bin/sh";
  root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-catch-up-")));
  // This checkout's compiled engine is the release's own binary, so the
  // install verifies it as it would a published one and a pin can use it.
  const engine = join(root, process.platform === "win32" ? "aidlc-engine.exe" : "aidlc-engine");
  const built = spawnSync(process.execPath, [
    "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", engine,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const release = join(root, "release");
  mkdirSync(release);
  // opencode beside claude: its session start, run as its adapter runs it.
  writeReleaseFixture({ root: release, repoRoot: REPO_ROOT, version: AIDLC_VERSION, binaryFrom: engine, distributions: ["claude", "opencode"] });
  const machine = join(root, "machine");
  const bin = join(machine, "bin");
  env = testGuardEnvironment(process.env, "production");
  for (const key of Object.keys(env)) {
    if (/^(?:AIDLC|CLAUDE|KIRO|CURSOR)_PROJECT_DIR$|^AIDLC_TEST_CONFIG_TTY$/i.test(key)) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env = {
    ...env,
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    AIDLC_GH_BIN: join(root, "no-gh", process.platform === "win32" ? "gh.exe" : "gh"),
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    [pathKey]: [bin, env[pathKey] ?? ""].join(process.platform === "win32" ? ";" : ":"),
  };
  // The organisation's mirror serves the release.
  const mirror = serveReleaseFixture(release);
  try {
    const child = Bun.spawn([
      process.execPath, join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts"),
      "update", "--version", AIDLC_VERSION, "--release-base-url", mirror.baseUrl,
    ], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status, out + err).toBe(0);
    expect(mirror.requests.length).toBeGreaterThan(0);
  } finally {
    mirror.stop();
  }
  earlierTree = stampedTree(shifted(AIDLC_VERSION, -1));
  laterTree = stampedTree(shifted(AIDLC_VERSION, 1));
});

afterAll(() => {
  if (timings.length > 0) console.log(`session start times: ${timings.join("; ")}`);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(SKIP_REASON !== null)("each project catches up the next time it is opened", () => {
  test("the first chat's start refreshes the files and offers the tracked list's move with them, staging nothing; after a no the next start and config change nothing, the person's own commit carries nothing of the list, and a later yes moves it", () => {
    const dir = project(earlierTree);
    expect(stampVersion(dir)).toBe(shifted(AIDLC_VERSION, -1));
    const first = sessionStart(dir, "catch-up");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(stampVersion(dir)).toBe(AIDLC_VERSION);
    // One question for both: the files the refresh changed and the list's move, as one commit of their own.
    expect(first.stdout).toContain(catchUpAsked(dir));
    expect(first.stdout).toContain("ASK ONCE");
    // The message the commit carries: drafted first, said to nobody, in the update's own file, shown, the person's words replacing it.
    const file = `aidlc/.aidlc-engine/request-text/unit-record-message-update-${AIDLC_VERSION}.txt`;
    expect(readFileSync(join(dir, ...file.split("/")), "utf-8")).toBe(`Update AI-DLC to ${AIDLC_VERSION}\n`);
    expect(first.stdout).toContain(`over the message in \`${file}\``);
    expect(first.stdout).toContain("with the message from that file after it");
    expect(first.stdout).toContain("When they give their own commit message, write it to that file first");
    expect(first.stdout).toMatch(new RegExp(`On yes, run \`[^\`]* unit commit-record --update --commit-message-file ${file.replaceAll(".", "\\.")}\``));
    expect(first.stdout).not.toContain(catchUpSaid(dir));
    expect(catchUpAsked(dir)).not.toContain(": 1 file under");
    // Nothing is moved or staged before the person answers; the list is read where it is.
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
    // Recorded answers kept: --mcp none still writes no .mcp.json.
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    const status = git(dir, ["status", "--porcelain", "--", ":!aidlc"]);
    const second = sessionStart(dir, "next start");
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toContain("repos.json");
    expect(second.stdout).not.toContain("AI-DLC updated its own files");
    expect(git(dir, ["status", "--porcelain", "--", ":!aidlc"])).toBe(status);
    const configured = sh(dir, `aidlc config --project-dir "${dir.replaceAll("\\", "/")}" --harness claude`);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    expect(configured.stdout).not.toContain("repos.json");
    expect(git(dir, ["status", "--porcelain", "--", ":!aidlc"])).toBe(status);
    // The person said no: their own next commit carries their file alone.
    writeFileSync(join(dir, "notes.md"), "Mine.\n");
    git(dir, ["add", "notes.md"]);
    git(dir, ["commit", "-q", "-m", "notes"]);
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"])).toBe("notes.md");
    // A yes later, in their words: the update's own commit moves the list with the files, once.
    const yes = sh(dir, `aidlc unit commit-record --update --commit-message-file ${file}`);
    expect(yes.status, yes.stdout + yes.stderr).toBe(0);
    expect(git(dir, ["show", "--name-status", "--format=", "HEAD", "--", "repos.json", "aidlc/repos.json"]))
      .toMatch(/^R\d*\trepos\.json\taidlc\/repos\.json$/);
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
  });

  // Wherever no move is made (a no, which runs nothing, and every start that puts no question), the list a team
  // tracks stays where this release's one resolver reads it, with nothing staged.
  test("after a no, unattended, on no branch and in a pinned project, the list is read at the root", () => {
    const readAtRoot = (dir: string): void => {
      expect(reposManifestPath(dir)).toBe(join(dir, "repos.json"));
      expect(readWorkspaceRepos(dir).manifest?.repos.map((repo) => repo.name)).toEqual(["billing"]);
      expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    };
    const no = project(earlierTree);
    expect(sessionStart(no, "catch-up, then a no").stdout).toContain(catchUpAsked(no));
    readAtRoot(no);
    const unattended = project(earlierTree);
    const saved = env;
    env = { ...env, AIDLC_UNATTENDED: "1" };
    try {
      expect(sessionStart(unattended, "catch-up, unattended, tracked list").stdout).not.toContain("repos.json");
    } finally {
      env = saved;
    }
    readAtRoot(unattended);
    const detached = project(earlierTree);
    git(detached, ["checkout", "-q", "--detach"]);
    const away = sessionStart(detached, "catch-up, no branch, tracked list");
    expect(away.stdout).toContain(catchUpSaid(detached, true));
    expect(away.stdout).not.toContain("repos.json");
    readAtRoot(detached);
    const pinned = project(earlierTree, { pin: true });
    expect(sessionStart(pinned, "pinned, tracked list").status).toBe(0);
    readAtRoot(pinned);
  });

  test("an untracked list moves with nothing said of it; the files the refresh changed are offered", () => {
    const dir = project(earlierTree, { tracked: false });
    const first = sessionStart(dir, "catch-up, untracked list");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(stampVersion(dir)).toBe(AIDLC_VERSION);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(true);
    expect(first.stdout).not.toContain("repos.json");
    expect(first.stdout).toContain(catchUpAsked(dir, false));
  });

  // A release that adds a root file config writes new (AI-DLC's .gitattributes part): git shows it as an untracked
  // file at the root, which the offer names as AI-DLC's part and its yes commits with the rest.
  test("a release that adds AI-DLC's .gitattributes part: the first start names its part, and the yes commits the new file", () => {
    const tree = stampedTree(shifted(AIDLC_VERSION, -1));
    rmSync(join(tree, ".gitattributes"));
    rmSync(join(tree, ".claude", "tools", "data", "root-blocks", "gitattributes"));
    const descriptorPath = join(tree, ".claude", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8")) as { rootIntegrations: Array<{ path: string }> };
    descriptor.rootIntegrations = descriptor.rootIntegrations.filter((integration) => integration.path !== ".gitattributes");
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const dir = project(tree, { tracked: false });
    expect(existsSync(join(dir, ".gitattributes"))).toBe(false);
    const first = sessionStart(dir, "catch-up, a new root file");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(readFileSync(join(dir, ".gitattributes"), "utf-8")).toStartWith("# BEGIN AI-DLC:gitattributes\n");
    const n = git(dir, ["status", "--porcelain", "-uall", "--", ".claude"]).split("\n").filter(Boolean).length;
    expect(first.stdout).toContain(
      `AI-DLC updated its own files in this project to ${AIDLC_VERSION}: ${n} files under .claude and its part of .gitattributes changed. ` +
        "Want me to commit them on main, as one commit of their own? Nothing is pushed. I'd use this commit message:",
    );
    const file = `aidlc/.aidlc-engine/request-text/unit-record-message-update-${AIDLC_VERSION}.txt`;
    const yes = sh(dir, `aidlc unit commit-record --update --commit-message-file ${file}`);
    expect(yes.status, yes.stdout + yes.stderr).toBe(0);
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n")).toContain(".gitattributes");
    expect(git(dir, ["status", "--porcelain", "--", ".gitattributes"])).toBe("");
  });

  test("unattended or on no branch, today's line and no offer; a settings file that held their words is left and named", () => {
    const unattended = project(earlierTree);
    const saved = env;
    env = { ...env, AIDLC_UNATTENDED: "1" };
    try {
      const quiet = sessionStart(unattended, "catch-up, unattended");
      expect(quiet.stdout).toContain("TELL ONCE");
      expect(quiet.stdout).toContain(catchUpSaid(unattended));
      expect(quiet.stdout).not.toContain("repos.json");
      expect(existsSync(join(unattended, "repos.json"))).toBe(true);
      expect(git(unattended, ["diff", "--cached", "--name-only"])).toBe("");
      expect(quiet.stdout).not.toContain("Want me to commit");
      expect(quiet.stdout).not.toContain("Say when you want me to commit");
    } finally {
      env = saved;
    }
    const detached = project(earlierTree, { tracked: false });
    git(detached, ["checkout", "-q", "--detach"]);
    const away = sessionStart(detached, "catch-up, no branch");
    // Once HEAD is on a branch again the commit can run: the line says so, and the agent has the command for it.
    expect(away.stdout).toContain(catchUpSaid(detached, true));
    expect(away.stdout).toMatch(/When they ask for that commit, run `[^`]* unit commit-record --update` and tell them in plain words what it reports\./);
    expect(away.stdout).not.toContain("Want me to commit");
    const held = project(earlierTree, { tracked: false });
    const settings = join(held, ".claude", "settings.json");
    const value = JSON.parse(readFileSync(settings, "utf-8")) as { permissions?: { allow?: string[] } };
    writeFileSync(settings, `${JSON.stringify({ ...value, permissions: { ...value.permissions, allow: [...(value.permissions?.allow ?? []), "Bash(make test)"] } }, null, 2)}\n`);
    // The rest is offered; the settings file that held their words is named and left by the yes.
    const words = sessionStart(held, "catch-up, settings with their words");
    expect(words.stdout).toContain("Want me to commit them on main, as one commit of their own? Nothing is pushed. I'd leave " +
      ".claude/settings.json out, as I cannot be sure it holds only AI-DLC's changes: it is yours to look over and commit.");
    expect(words.stdout).toContain("unit commit-record --update --leave .claude/settings.json --commit-message-file");
  });

  // In a Unit's build the update's own commit is offered as anywhere, the list's move with it: none of its files is
  // the lead's record.
  test("in a checkout that builds a Unit, the files and the move are offered as one commit", () => {
    const dir = project(earlierTree);
    seedWorkspaceShell(dir);
    writeFileSync(seededStateFile(dir), readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8")
      .replace("- **Revision Count**: 0\n", "- **Revision Count**: 0\n- **Unit Build**: refunds\n"));
    const first = sessionStart(dir, "catch-up, a Unit's build");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(catchUpAsked(dir));
    expect(first.stdout).toContain("unit commit-record --update");
  });

  test("in a checkout that builds a Unit, the move alone is offered as one commit of its own", () => {
    const dir = project(earlierTree, { harnessCommitted: false });
    seedWorkspaceShell(dir);
    writeFileSync(seededStateFile(dir), readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8")
      .replace("- **Revision Count**: 0\n", "- **Revision Count**: 0\n- **Unit Build**: refunds\n"));
    const first = sessionStart(dir, "catch-up, the move alone in a Unit's build");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(
      "AI-DLC now keeps repos.json in aidlc/, and this project's is at the root. Want me to move it there on main, as one commit " +
        "of its own? Nothing is pushed. Teammates need AI-DLC 2.12 or newer to find it there. I'd use this commit message:",
    );
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(first.stdout).toContain("unit commit-record --update --commit-message-file");
    expect(first.stdout).toContain("about the move of repos.json into aidlc/");
  });

  // opencode carries no session-start context: where the offer is worked out its line is not left waiting for the
  // next step, which puts the question itself; where it is not (unattended), today's line waits there.
  test("on opencode, the offer worked out leaves no line waiting; unattended, the line waits for the next step", () => {
    const waiting = (dir: string): string => {
      const file = join(dir, "aidlc", ".aidlc-engine", "sessions", `${SESSION}.person-lines`);
      return existsSync(file) ? readFileSync(file, "utf-8") : "";
    };
    const saved = env;
    try {
      env = { ...env, AIDLC_HARNESS_NAME: "opencode", AIDLC_HARNESS_DIR: ".aidlc" };
      const offered = project(earlierTree, { tracked: false });
      const first = sessionStart(offered, "catch-up, opencode");
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(stampVersion(offered)).toBe(AIDLC_VERSION);
      const file = `aidlc/.aidlc-engine/request-text/unit-record-message-update-${AIDLC_VERSION}.txt`;
      expect(readFileSync(join(offered, ...file.split("/")), "utf-8")).toBe(`Update AI-DLC to ${AIDLC_VERSION}\n`);
      expect(waiting(offered)).not.toContain("AI-DLC updated its own files");
      env = { ...env, AIDLC_UNATTENDED: "1" };
      const quiet = project(earlierTree, { tracked: false });
      const unattended = sessionStart(quiet, "catch-up, opencode unattended");
      expect(unattended.status, unattended.stdout + unattended.stderr).toBe(0);
      expect(waiting(quiet)).toContain("AI-DLC updated its own files");
    } finally {
      env = saved;
    }
  });

  test("a project in a folder of its repo: the line counts its own folders", () => {
    const dir = project(earlierTree, { subfolder: true });
    const first = sessionStart(dir, "catch-up, subfolder");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(stampVersion(dir)).toBe(AIDLC_VERSION);
    expect(first.stdout).toContain(catchUpAsked(dir));
  });

  test("a harness folder git does not track, and a project not in git, say nothing of the files", () => {
    const untracked = project(earlierTree, { tracked: false, harnessCommitted: false });
    const started = sessionStart(untracked, "catch-up, untracked .claude");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(stampVersion(untracked)).toBe(AIDLC_VERSION);
    expect(started.stdout).not.toContain("AI-DLC updated its own files");
    const away = project(earlierTree, { git: false });
    const outside = sessionStart(away, "catch-up, no git");
    expect(outside.status, outside.stdout + outside.stderr).toBe(0);
    expect(stampVersion(away)).toBe(AIDLC_VERSION);
    expect(outside.stdout).not.toContain("AI-DLC updated its own files");
  });

  // A rebase of theirs stopped on a conflict when a chat opens: the refresh waits for a later chat's start, so their
  // own `git add` and `git rebase --continue` go through as without AI-DLC, and nothing of AI-DLC's joins their
  // commit; the next chat's start, with the rebase finished, refreshes as before.
  test("a chat that opens while their rebase is stopped on a conflict changes nothing; the next start after it refreshes", () => {
    const dir = project(earlierTree, { tracked: false });
    const commit = (file: string, text: string, message: string): void => {
      writeFileSync(join(dir, file), text);
      git(dir, ["add", "--", file]);
      git(dir, ["commit", "-q", "-m", message]);
    };
    git(dir, ["switch", "-q", "-c", "feature"]);
    commit("notes.txt", "feature\n", "feature change");
    git(dir, ["switch", "-q", "main"]);
    commit("notes.txt", "main\n", "main change");
    git(dir, ["switch", "-q", "feature"]);
    const stopped = spawnSync("git", ["rebase", "main"], { cwd: dir, encoding: "utf-8", env });
    expect(stopped.status, stopped.stdout + stopped.stderr).not.toBe(0);
    const earlier = stampVersion(dir);
    const started = sessionStart(dir, "catch-up, rebase stopped");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    writeFileSync(join(dir, "notes.txt"), "feature and main\n");
    git(dir, ["add", "--", "notes.txt"]);
    const continued = spawnSync("git", ["rebase", "--continue"], { cwd: dir, encoding: "utf-8", env: { ...env, GIT_EDITOR: "true" } });
    expect(continued.status, continued.stdout + continued.stderr).toBe(0);
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean)).toEqual(["notes.txt"]);
    expect(stampVersion(dir)).toBe(earlier);
    expect(started.stdout).not.toContain("AI-DLC updated its own files");
    const next = sessionStart(dir, "catch-up, after the rebase");
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(stampVersion(dir)).toBe(AIDLC_VERSION);
  });

  test("a pinned project and a newer stamp are left alone", () => {
    const pinned = project(earlierTree, { pin: true });
    expect(sessionStart(pinned, "pinned").status).toBe(0);
    expect(stampVersion(pinned)).toBe(shifted(AIDLC_VERSION, -1));
    expect(existsSync(join(pinned, "repos.json"))).toBe(true);
    const later = project(laterTree);
    expect(sessionStart(later, "newer stamp").status).toBe(0);
    expect(stampVersion(later)).toBe(shifted(AIDLC_VERSION, 1));
    expect(existsSync(join(later, "repos.json"))).toBe(true);
  });

  test("the status line, a tool call's hook, a compaction's start and Cursor's per-prompt probe never run the refresh", () => {
    const dir = project(earlierTree);
    // AI-DLC's status line command, as Claude Code runs it.
    const line = sh(dir, "aidlc engine statusline", JSON.stringify({ session_id: SESSION, cwd: dir }));
    expect(line.status, line.stdout + line.stderr).toBe(0);
    const tool = { session_id: SESSION, cwd: dir, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "repos.json") } };
    const pre = sh(dir, hookCommand(dir, "PreToolUse"), JSON.stringify(tool));
    expect(pre.status, pre.stdout + pre.stderr).toBe(0);
    expect(sessionStart(dir, "compaction", { source: "compact" }).status).toBe(0);
    expect(sessionStart(dir, "probe", { source: "resume", rebind_check: true }).status).toBe(0);
    expect(stampVersion(dir)).toBe(shifted(AIDLC_VERSION, -1));
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
  });

  test("a refresh config refuses says nothing and stops nothing", () => {
    const dir = project(earlierTree);
    // A file of AI-DLC's the person changed: config refuses to refresh over it.
    const agent = join(dir, ".claude", "agents", "aidlc-developer-agent.md");
    writeFileSync(agent, `${readFileSync(agent, "utf-8")}\nmine\n`);
    const started = sessionStart(dir, "refused refresh");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.stdout).not.toContain("repos.json");
    expect(stampVersion(dir)).toBe(shifted(AIDLC_VERSION, -1));
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    expect(readFileSync(agent, "utf-8")).toEndWith("\nmine\n");
  });

});
