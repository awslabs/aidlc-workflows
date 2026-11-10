// covers: cli:aidlc-utility(intent add-repo, intent remove-repo, intent set-repos), function:handleIntentRepos, function:plannedRepoClone, function:unitsRepoChangeAtChange, function:stageWorkspaceRepo, function:installWorkspaceRepo, function:workspaceManifestWith, function:hostedAddressOwner, function:withoutCredentials
//
// A piece of work that already records sibling repos gains or loses one, at any
// stage. The engine checks the name and the folder (a real .git entry, which a
// commit can never carry), clones a repo that is not here yet the way
// workspace-sync does and with the person's own git setup, writes repos.json,
// records INTENT_REPOS_CHANGED, then the registry row, and says one line. After
// Units Generation is approved the change lands too: relaxed or off record it
// as accepted with one line; strict leaves the question to the next step.
// Work that records none works on the workspace folder itself: before
// Construction it takes its first repos, from where repos.json puts them or the
// folder the person named; after, add-checkout is the way on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createTestProject,
  intentsDirOf,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  readUnitSourceManifest,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-00000000ad01";
let proj: string;

function guardBash(command: string): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Bash",
      tool_input: { command },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

function personSays(prompt: string): void {
  const r = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`record-human-turn failed: ${r.stderr}`);
}

// The person's own git setup for these runs: one global config file of theirs,
// whose insteadOf rules send the team's addresses to local bare repos.
let gitHome: string;
let gitConfig: string;
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// A refusal prints {"error": "..."}: its text is read the way it is said, so a
// Windows path in it has single backslashes.
// A run from a host's own shell names no chat unless a case gives one.
const CHAT_VARIABLES = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID", "AIDLC_SESSION_OVERRIDE"];

function utility(args: string[], env: NodeJS.ProcessEnv = {}): { rc: number; out: string } {
  const base = gitEnv();
  for (const name of CHAT_VARIABLES) delete base[name];
  const r = spawnSync(process.execPath, [UTIL, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...base, ...env },
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

function git(dir: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

// A bare repo under the person's git home, with one commit, that an address
// in their git config points at.
function bareRepo(owner: string, name: string): string {
  const work = join(gitHome, "work", owner, name);
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "api.ts"), "export const api = 1;\n");
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "seed"]);
  const bare = join(gitHome, "remotes", owner, `${name}.git`);
  mkdirSync(join(gitHome, "remotes", owner), { recursive: true });
  const r = spawnSync("git", ["clone", "-q", "--bare", work, bare], { encoding: "utf-8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git clone --bare failed: ${r.stderr}`);
  return bare;
}

// A backslash inside a quoted git config value is an escape, so the base is
// written with forward slashes, which git takes on Windows too.
function insteadOf(prefix: string, owner: string): void {
  const base = join(gitHome, "remotes", owner).replaceAll("\\", "/");
  writeFileSync(gitConfig, `${readFileSync(gitConfig, "utf-8")}[url "${base}/"]\n\tinsteadOf = ${prefix}\n`);
}

// Every git process the add starts writes a line here; a file never made means none ran.
function gitTrace(): { env: NodeJS.ProcessEnv; ranRemote: () => boolean } {
  const file = join(mkdtempSync(join(gitHome, "trace-")), "trace.log");
  return {
    env: { GIT_TRACE: file },
    ranRemote: () => existsSync(file) && /\bgit (clone|fetch|ls-remote)\b/.test(readFileSync(file, "utf-8")),
  };
}

function notListedLine(name: string): string {
  return `${name} is not in this workspace yet, and no repos.json lists it, so there is no address to clone it from. ` +
    "Give its clone address with --url, or clone it beside the other repos, then add it again.";
}

function stagingLeft(): string[] {
  return readdirSync(proj).filter((name) => name.startsWith(".aidlc-workspace-sync-txn-"));
}

function unitsApproved(policy: "strict" | "relaxed" | "off"): void {
  setCheckbox("units-generation", "x");
  const statePath = seededStateFile(proj);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, `- **Change Control**: ${policy} (you)`),
  );
  appendAuditEntry("STAGE_COMPLETED", { Stage: "units-generation", Details: "approved", Artifacts: "units" }, proj);
}

// A sibling code repo: an immediate child of the workspace with its own .git.
function siblingRepo(name: string): void {
  const dir = join(proj, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "seed"]);
}

function registry(): string {
  return join(intentsDirOf(proj), "intents.json");
}

function recordRepos(repos: string[]): void {
  const rows = JSON.parse(readFileSync(registry(), "utf-8")) as Array<Record<string, unknown>>;
  writeFileSync(registry(), `${JSON.stringify(rows.map((row) => ({ ...row, repos })), null, 2)}\n`);
}

function repos(): string[] | undefined {
  return (JSON.parse(readFileSync(registry(), "utf-8")) as Array<{ repos?: string[] }>)[0].repos;
}

function audit(): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf-8")).join("\n");
}

function setCheckbox(slug: string, mark: string): void {
  const statePath = seededStateFile(proj);
  const state = readFileSync(statePath, "utf-8");
  writeFileSync(statePath, state.replace(new RegExp(`^- \\[.\\] ${slug} `, "m"), `- [${mark}] ${slug} `));
}

describe("intent add-repo / remove-repo", () => {
  beforeEach(() => {
    resetAidlcEnv();
    gitHome = mkdtempSync(join(tmpdir(), "aidlc-add-repo-git-"));
    gitConfig = join(gitHome, "gitconfig");
    writeFileSync(gitConfig, "[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n");
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md"); // Current Stage: feasibility; Units Generation pending
    siblingRepo("app-a");
    siblingRepo("app-b");
    recordRepos(["app-a"]);
  });

  afterEach(() => {
    cleanupTestProject(proj);
    cleanupTestProject(gitHome);
  });

  test("adds a sibling repo: the registry row, the audit row, one line", () => {
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a", "app-b"]);
    expect(r.out).toContain("Added app-b to this piece of work's repos.");
    expect(r.out).toContain("You can remove it again any time.");
    const rows = audit();
    expect(rows).toContain("**Event**: INTENT_REPOS_CHANGED");
    expect(rows).toContain("**Added**: app-b");
    expect(rows).toContain("**Repos**: app-a, app-b");
  });

  test("the Construction manifest that named the repo is accepted once the repo is recorded", () => {
    const dir = join(seededRecordDir(proj), "construction", "alpha", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "app-b", path: "src/" }] })}\n`,
    );
    const before = readUnitSourceManifest(proj, "code-generation", "alpha");
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.reason).toContain('"app-b" is not recorded for this intent');
      expect(before.unrecordedRepo).toBe("app-b");
    }
    expect(utility(["intent", "add-repo", "app-b"]).rc).toBe(0);
    expect(readUnitSourceManifest(proj, "code-generation", "alpha").ok).toBe(true);
  });

  test("a reason that carries an address with a credential is recorded without it", () => {
    const r = utility(["intent", "add-repo", "app-b", "--reason", "the API moved to https://bot:s3cret-tok@git.example.invalid/acme/app-b.git"]);
    expect(r.rc, r.out).toBe(0);
    expect(audit()).not.toContain("s3cret-tok");
    expect(audit()).toContain("**Reason**: the API moved to https://***@git.example.invalid/acme/app-b.git");
  });

  test("a repo already recorded changes nothing and says so", () => {
    const r = utility(["intent", "add-repo", "app-a"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a"]);
    expect(r.out).toContain("app-a is already one of this piece of work's repos; nothing changed.");
    expect(audit()).not.toContain("INTENT_REPOS_CHANGED");
  });

  test("refuses a name that is not a repo name", () => {
    const r = utility(["intent", "add-repo", "../outside"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("is not a repo name");
    expect(repos()).toEqual(["app-a"]);
  });

  test("refuses a folder without a real .git entry, including a committed folder shaped like a repo", () => {
    const shaped = join(proj, "vendor");
    mkdirSync(join(shaped, "objects"), { recursive: true });
    mkdirSync(join(shaped, "refs"), { recursive: true });
    writeFileSync(join(shaped, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(shaped, "config"), "[core]\n\tbare = false\n\tworktree = .\n");
    const r = utility(["intent", "add-repo", "vendor"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("is not a Git checkout");
    expect(repos()).toEqual(["app-a"]);
  });

  test("work that records no repos takes its first one before Construction, said once", () => {
    recordRepos([]);
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-b"]);
    expect(r.out).toContain("Added app-b to this piece of work's repos; until now it worked on the workspace folder itself, which it still reads.");
    expect(audit()).toContain("**Added**: app-b");
  });

  test("removes a repo, never the last one", () => {
    recordRepos(["app-a", "app-b"]);
    const r = utility(["intent", "remove-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a"]);
    expect(r.out).toContain("Removed app-b from this piece of work's repos. Its folder stays. You can add it back any time.");
    expect(audit()).toContain("**Removed**: app-b");
    const last = utility(["intent", "remove-repo", "app-a"]);
    expect(last.rc).not.toBe(0);
    expect(last.out).toContain("is the only repo this piece of work records");
    expect(repos()).toEqual(["app-a"]);
    const absent = utility(["intent", "remove-repo", "app-b"]);
    expect(absent.rc, absent.out).toBe(0);
    expect(absent.out).toContain("app-b is not one of this piece of work's repos");
  });

  test("after Units Generation is approved under strict the add lands, and the question is left to the next step", () => {
    unitsApproved("strict");
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a", "app-b"]);
    expect(r.out).not.toContain("go back to Units Generation");
    expect(r.out).not.toContain("carrying on with its Units");
    expect(audit()).toContain("**Added**: app-b");
    expect(audit()).not.toContain("CHANGE_ACCEPTED");
  });

  for (const policy of ["relaxed", "off"] as const) {
    test(`after Units Generation is approved under ${policy} the change is recorded as accepted, once, with the way back`, () => {
      unitsApproved(policy);
      const r = utility(["intent", "add-repo", "app-b"]);
      expect(r.rc, r.out).toBe(0);
      expect(repos()).toEqual(["app-a", "app-b"]);
      expect(r.out).toContain(
        "Units Generation was approved before this change: carrying on with its Units and app-b added. You can go back to Units Generation any time.",
      );
      const accepted = audit().split("\n## ").filter((block) => block.includes("CHANGE_ACCEPTED"));
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toContain("**Checkpoint**: units-generation");
      expect(accepted[0]).toMatch(/\*\*Recorded\*\*: app-a \(Units Generation approved \d{4}-\d\d-\d\dT[\d:]+Z\)/);
      expect(accepted[0]).toContain("**Current**: app-a, app-b");
    });
  }

  test("removing the repo added after Units Generation is the undo: nothing more to decide", () => {
    unitsApproved("off");
    expect(utility(["intent", "add-repo", "app-b"]).rc).toBe(0);
    const before = audit().split("CHANGE_ACCEPTED").length;
    const r = utility(["intent", "remove-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a"]);
    expect(r.out).not.toContain("carrying on with its Units");
    expect(audit().split("CHANGE_ACCEPTED").length).toBe(before);
  });

  test("set-repos after Units Generation lands too, and names add-repo for a repo not cloned here", () => {
    unitsApproved("off");
    const r = utility(["intent", "set-repos", "app-a,app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a", "app-b"]);
    expect(r.out).toContain("This work now covers app-a and app-b. Units Generation was approved before this change:");
    const missing = utility(["intent", "set-repos", "app-a,payments"]);
    expect(missing.rc).not.toBe(0);
    expect(missing.out).toContain("Nothing was changed. To clone it and add it to this work, run `");
    expect(missing.out).toContain("intent add-repo payments`.");
    expect(repos()).toEqual(["app-a", "app-b"]);
  });

  // In Code Generation, before a plan is approved, the plan-approval guard holds
  // the build: the developer and the code. A repo change is AI-DLC's own
  // command, and the engine owns its judgement (whose folder, which flags), so
  // the guard passes it in its plain native spelling whether or not a person
  // has spoken yet.
  test("the plan-approval guard lets the person's repo change through while a plan waits", () => {
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation"),
    );
    // The engine has named the step (Code Generation runs, its plan not yet
    // approved), so the guard watches the agent's commands.
    writeActiveDirectiveMarker(proj, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: stateDigest(readFileSync(statePath, "utf-8")),
    });
    const unasked = guardBash("aidlc engine intent add-repo app-b");
    expect(unasked.code, unasked.stderr).toBe(0);
    personSays("the consent banner also needs a change in app-b, add that repo to this piece of work");
    const addition = guardBash("aidlc engine intent add-repo app-b");
    expect(addition.code, addition.stderr).toBe(0);
    const removal = guardBash("aidlc engine intent remove-repo app-b");
    expect(removal.code, removal.stderr).toBe(0);
    const flagged = guardBash('aidlc engine intent add-repo app-b --reason "the banner needs it"');
    expect(flagged.code, flagged.stderr).toBe(0);
    // Another folder on the line is the engine's own to refuse.
    expect(guardBash("aidlc engine intent add-repo app-b --project-dir /elsewhere").code).toBe(0);
  });

  test("the line says what Reverse Engineering will do for the new repo", () => {
    const pending = utility(["intent", "add-repo", "app-b"]);
    expect(pending.out).toContain("Reverse Engineering will cover app-b when it runs.");
    recordRepos(["app-a"]);
    setCheckbox("reverse-engineering", "x");
    const done = utility(["intent", "add-repo", "app-b"]);
    expect(done.out).toContain(
      "Reverse Engineering has not documented app-b yet, so it and the stages that read the code knowledge may show as behind until you revisit them.",
    );
  });

  test("the line on removing a repo repos.json lists says its line stays and how to drop it", () => {
    recordRepos(["app-a", "app-b"]);
    writeFileSync(join(proj, "repos.json"), '{ "org": "acme", "repos": [{ "name": "app-a" }, { "name": "app-b" }] }\n');
    const r = utility(["intent", "remove-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain(
      "Removed app-b from this piece of work's repos. Its folder stays, and so does its line in repos.json (delete that line to take it off the workspace's list). You can add it back any time.",
    );
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toContain('"app-b"');
  });
});

describe("intent add-repo clones a repo that is not here yet", () => {
  beforeEach(() => {
    resetAidlcEnv();
    gitHome = mkdtempSync(join(tmpdir(), "aidlc-add-repo-git-"));
    gitConfig = join(gitHome, "gitconfig");
    writeFileSync(gitConfig, "[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n");
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    siblingRepo("app-a");
    recordRepos(["app-a"]);
  });

  afterEach(() => {
    cleanupTestProject(proj);
    cleanupTestProject(gitHome);
  });

  test("a repo repos.json lists by name alone is cloned from its org, through the person's own git config: installed, recorded, said", () => {
    bareRepo("acme", "payments");
    insteadOf("git@github.com:acme/", "acme");
    const raw = '{\n  // the team\'s repos\n  "org": "acme",\n  "repos": [\n    { "name": "app-a" },\n    { "name": "payments" }\n  ]\n}\n';
    writeFileSync(join(proj, "repos.json"), raw);
    const r = utility(["intent", "add-repo", "payments", "--reason", "the consent API lives in payments"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out.trim()).toBe(
      "Cloned payments from git@github.com:acme/payments.git and added it to this piece of work's repos. " +
        "Reverse Engineering will cover payments when it runs. You can remove it again any time.",
    );
    expect(existsSync(join(proj, "payments", "src", "api.ts"))).toBe(true);
    expect(repos()).toEqual(["app-a", "payments"]);
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toBe(raw);
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toContain("/payments/\n");
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toContain("/.aidlc-workspace-sync-txn-*/\n");
    expect(JSON.parse(readFileSync(join(proj, "aidlc.code-workspace"), "utf-8")).folders).toContainEqual({ path: "payments" });
    const rows = audit();
    expect(rows).toContain("**Added**: payments");
    expect(rows).toContain("**Cloned From**: git@github.com:acme/payments.git");
    expect(rows).toContain("**Reason**: the consent API lives in payments");
    expect(rows).toMatch(/\*\*Source Baseline Addition\*\*: sha256:[0-9a-f]{64}/);
    expect(stagingLeft()).toEqual([]);
  });

  test("a team's clone adds the repo to the shared list in aidlc/, never a one-repo file at the root", () => {
    bareRepo("acme", "payments");
    insteadOf("git@github.com:acme/", "acme");
    const shared = '{\n  "org": "acme",\n  "repos": [\n    { "name": "app-a" }\n  ]\n}\n';
    writeFileSync(join(proj, "aidlc", "repos.json"), shared);
    // A repo the list does not name clones only from the address the person gives.
    const r = utility(["intent", "add-repo", "payments", "--url", "git@github.com:acme/payments.git"]);
    expect(r.rc, r.out).toBe(0);
    expect(existsSync(join(proj, "repos.json"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8")) as { repos: Array<{ name: string }> };
    expect(manifest.repos.map((repo) => repo.name)).toEqual(["app-a", "payments"]);
  });

  test("from the person's --url, with no repos.json: a local path creates none and the line says so", () => {
    const bare = bareRepo("local", "payments");
    const r = utility(["intent", "add-repo", "payments", "--url", bare, "--person-words", "add payments from my local copy"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain(`Cloned payments from ${bare} and added it to this piece of work's repos.`);
    expect(r.out).toContain("This workspace has no repos.json, so a teammate's workspace does not get it by itself.");
    expect(existsSync(join(proj, "repos.json"))).toBe(false);
    expect(existsSync(join(proj, "payments", ".git"))).toBe(true);
    expect(audit()).toContain("**Person Words**: add payments from my local copy");
    expect(repos()).toEqual(["app-a", "payments"]);
  });

  test("a hosted --url creates repos.json under its owner, without the credential, and no secret is printed or recorded", () => {
    bareRepo("acme", "payments");
    insteadOf("https://user:s3cret-tok@example.invalid/acme/", "acme");
    const r = utility([
      "intent", "add-repo", "payments", "--url", "https://user:s3cret-tok@example.invalid/acme/payments.git",
      "--person-words", "add payments from https://user:s3cret-tok@example.invalid/acme/payments.git",
    ]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain("Cloned payments from https://***@example.invalid/acme/payments.git");
    expect(r.out).toContain(
      "repos.json is new: it lists payments under the org acme; commit it to share the list with your team. " +
        "Its address there leaves out the credential.",
    );
    const manifest = JSON.parse(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8"));
    expect(manifest).toEqual({ org: "acme", repos: [{ name: "payments", url: "https://example.invalid/acme/payments.git" }] });
    expect(r.out).not.toContain("s3cret-tok");
    expect(audit()).not.toContain("s3cret-tok");
    expect(audit()).toContain("**Person Words**: add payments from https://***@example.invalid/acme/payments.git");
    expect(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8")).not.toContain("s3cret-tok");
  });

  // The list a first add by address writes names that address's owner as its
  // org, on any host; a later add by name of a repo the list does not name
  // must not turn that owner into a github.com address. The trap sends that
  // made-up address to a real local repo, so a clone of it would go through.
  test.each([
    ["a GitLab-style https address", "https://gitlab.example.invalid/code/"],
    ["an ssh address on another host", "git@git.example.invalid:code/"],
    ["a git:// address", "git://git.example.invalid/code/"],
    ["a github.com address", "https://github.com/code/"],
  ])("after a first add by %s, a repo the list does not name is asked for and nothing is cloned", (_shape, prefix) => {
    bareRepo("code", "storefront");
    insteadOf(prefix, "code");
    bareRepo("trap", "billing");
    insteadOf("git@github.com:code/", "trap");
    const first = gitTrace();
    const added = utility(["intent", "add-repo", "storefront", "--url", `${prefix}storefront.git`], first.env);
    expect(added.rc, added.out).toBe(0);
    expect(first.ranRemote()).toBe(true);
    expect(added.out).toContain("repos.json is new: it lists storefront under the org code; commit it to share the list with your team.");
    const raw = readFileSync(join(proj, "aidlc", "repos.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ org: "code", repos: [{ name: "storefront", url: `${prefix}storefront.git` }] });

    const second = gitTrace();
    const r = utility(["intent", "add-repo", "billing", "--person-words", "add the billing repo too"], second.env);
    expect(r.rc, r.out).not.toBe(0);
    expect(r.out).toContain(notListedLine("billing"));
    expect(r.out).not.toContain("github.com:code/billing");
    expect(second.ranRemote()).toBe(false);
    expect(existsSync(join(proj, "billing"))).toBe(false);
    expect(repos()).toEqual(["app-a", "storefront"]);
    expect(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8")).toBe(raw);
    expect(audit()).not.toContain("**Added**: billing");
    expect(stagingLeft()).toEqual([]);
  });

  test("a team's own list: a repo it does not name is asked for, then cloned from the address the person gives", () => {
    bareRepo("acme", "payments");
    insteadOf("git@github.com:acme/", "acme");
    const raw = '{\n  // the team\'s repos\n  "org": "acme",\n  "repos": [\n    { "name": "app-a" }\n  ]\n}\n';
    writeFileSync(join(proj, "repos.json"), raw);
    const asked = gitTrace();
    const r = utility(["intent", "add-repo", "payments"], asked.env);
    expect(r.rc, r.out).not.toBe(0);
    expect(r.out).toContain(notListedLine("payments"));
    expect(asked.ranRemote()).toBe(false);
    expect(existsSync(join(proj, "payments"))).toBe(false);
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toBe(raw);
    expect(audit()).not.toContain("**Added**: payments");

    const given = gitTrace();
    const added = utility(["intent", "add-repo", "payments", "--url", "git@github.com:acme/payments.git"], given.env);
    expect(added.rc, added.out).toBe(0);
    expect(given.ranRemote()).toBe(true);
    expect(added.out.trim()).toBe(
      "Cloned payments from git@github.com:acme/payments.git and added it to this piece of work's repos. " +
        "repos.json now lists it. Reverse Engineering will cover payments when it runs. You can remove it again any time.",
    );
    const manifest = readFileSync(join(proj, "repos.json"), "utf-8");
    expect(manifest).toContain("// the team's repos");
    expect(manifest).toContain('"url": "git@github.com:acme/payments.git"');
    expect(repos()).toEqual(["app-a", "payments"]);
  });

  test("a failed clone records nothing, says git's reason and the command to run by hand, and leaves no staging folder", () => {
    writeFileSync(join(proj, "repos.json"), '{ "org": "acme", "repos": [{ "name": "app-a" }] }\n');
    const missing = join(gitHome, "nowhere", "payments.git");
    const r = utility(["intent", "add-repo", "payments", "--url", missing]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain(`Could not clone payments from ${missing}: `);
    expect(r.out).toContain(`Nothing was changed. To clone it yourself, run git clone -- "${missing}" "${join(proj, "payments")}", then add it again.`);
    expect(r.out).not.toContain("Cloning into");
    expect(repos()).toEqual(["app-a"]);
    expect(audit()).not.toContain("INTENT_REPOS_CHANGED");
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toBe('{ "org": "acme", "repos": [{ "name": "app-a" }] }\n');
    expect(existsSync(join(proj, "payments"))).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });

  test("a failed clone of an address with a credential prints it masked", () => {
    const r = utility(["intent", "add-repo", "payments", "--url", "https://user:s3cret-tok@127.0.0.1:9/acme/payments.git"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Could not clone payments from https://***@127.0.0.1:9/acme/payments.git: ");
    expect(r.out).toContain(`run git clone -- <the address with its credential> "${join(proj, "payments")}", then add it again.`);
    expect(r.out).not.toContain("s3cret-tok");
  });

  test("a failed clone of a repo repos.json puts on a branch names that branch in the command to run by hand", () => {
    const missing = join(gitHome, "nowhere", "payments.git");
    writeFileSync(
      join(proj, "repos.json"),
      `{ "org": "acme", "repos": [{ "name": "app-a" }, { "name": "payments", "url": ${JSON.stringify(missing)}, "branch": "release" }] }\n`,
    );
    const r = utility(["intent", "add-repo", "payments"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain(`To clone it yourself, run git clone --branch release -- "${missing}" "${join(proj, "payments")}", then add it again.`);
  });

  test("no repos.json and no --url: one line says what to give, and nothing changes", () => {
    const r = utility(["intent", "add-repo", "payments"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain(notListedLine("payments"));
    expect(repos()).toEqual(["app-a"]);
    expect(stagingLeft()).toEqual([]);
  });

  test("a repos.json with no org that does not list the repo, and no --url: one line asks for the address, never an empty one", () => {
    const raw = `${JSON.stringify({ repos: [{ name: "app-a" }] })}\n`;
    writeFileSync(join(proj, "repos.json"), raw);
    const r = utility(["intent", "add-repo", "payments"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain(notListedLine("payments"));
    expect(r.out).not.toContain("undefined");
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toBe(raw);
    expect(repos()).toEqual(["app-a"]);
    expect(stagingLeft()).toEqual([]);
  });

  // Kiro CLI's prompt hook runs a typed `/aidlc intent ...` itself, with no
  // agent between: the person's address and their quoted reason arrive whole.
  test("on Kiro CLI the typed command clones the repo through the prompt hook and keeps the quoted reason whole", () => {
    const bare = bareRepo("local", "payments");
    cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(proj, ".kiro"), { recursive: true });
    const r = spawnSync(process.execPath, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"], {
      cwd: proj,
      input: JSON.stringify({
        prompt: `/aidlc intent add-repo payments --url ${bare} --reason "the consent API lives there"`,
        cwd: proj,
      }),
      encoding: "utf-8",
      env: { ...gitEnv(), CLAUDE_PROJECT_DIR: proj },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`Cloned payments from ${bare} and added it to this piece of work's repos.`);
    expect(existsSync(join(proj, "payments", "src", "api.ts"))).toBe(true);
    expect(repos()).toEqual(["app-a", "payments"]);
    expect(audit()).toContain("**Reason**: the consent API lives there\n");
  });

  test("a repo repos.json declares but nobody cloned is cloned from its own entry; repos.json is left as it is", () => {
    bareRepo("acme", "payments");
    const raw = `{ "org": "elsewhere", "repos": [{ "name": "app-a" }, { "name": "payments", "url": ${JSON.stringify(join(gitHome, "remotes", "acme", "payments.git"))} }] }\n`;
    writeFileSync(join(proj, "repos.json"), raw);
    const r = utility(["intent", "add-repo", "payments"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).not.toContain("repos.json now lists it");
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toBe(raw);
    expect(existsSync(join(proj, "payments", ".git"))).toBe(true);
  });

  // x2783-f3: a workspace that keeps its repos under src/; the person says to
  // clone notify from an address into src/notify. The add clones it there and
  // repos.json keeps the address with the folder, so a teammate's clone gets it.
  test("--path with --url: cloned into the folder the person named, and repos.json keeps the address with it", () => {
    const bare = bareRepo("local", "notify");
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`);
    const r = utility(["intent", "add-repo", "notify", "--path", "src/notify", "--url", bare]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out.trim()).toBe(
      `Cloned notify from ${bare} and added it to this piece of work's repos. repos.json now lists notify at src/notify. ` +
        "Commit it to share it with your team. Reverse Engineering will cover notify when it runs. You can remove it again any time.",
    );
    expect(existsSync(join(proj, "src", "notify", "src", "api.ts"))).toBe(true);
    expect(existsSync(join(proj, "notify"))).toBe(false);
    expect(JSON.parse(readFileSync(join(proj, "repos.json"), "utf-8")).repos).toEqual([
      { name: "app-a" },
      { name: "notify", path: "src/notify", url: bare },
    ]);
    expect(repos()).toEqual(["app-a", "notify"]);
    const rows = audit();
    expect(rows).toContain(`**Cloned From**: ${bare}`);
    expect(rows).toContain("**Listed At**: src/notify");
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toContain("/src/notify/\n");
    expect(stagingLeft()).toEqual([]);
  });

  // A staging folder an earlier add left beside a folder outside the workspace
  // (a run stopped mid-clone): the next add of that repo says it after its own
  // line, with where it is, and leaves it for the person to delete.
  test("--path outside the workspace with --url: a staging folder an earlier add left there is said after the add's line, and kept", () => {
    const bare = bareRepo("local", "notify");
    const away = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-add-away-")));
    try {
      const left = join(away, ".aidlc-workspace-sync-clone-notify-Ab12Cd");
      mkdirSync(left);
      writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`);
      const r = utility(["intent", "add-repo", "notify", "--path", join(away, "notify").replace(/\\/g, "/"), "--url", bare]);
      expect(r.rc, r.out).toBe(0);
      expect(existsSync(join(away, "notify", ".git"))).toBe(true);
      expect(r.out.trim().split("\n").at(-1)).toBe(
        `AI-DLC could not remove the temporary folder ${left} it made to clone notify; nothing in it is needed, so you can delete it.`,
      );
      expect(existsSync(left)).toBe(true);
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
  });

  // In a chat the agent may not pass a command's own output on, so the line
  // rides the chat's next step, which the agent says, and is said once there.
  test("from a chat: a staging folder an earlier add left is kept for the reply the turn ends on, not only printed", () => {
    const bare = bareRepo("local", "notify");
    const away = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-add-away-")));
    try {
      const left = join(away, ".aidlc-workspace-sync-clone-notify-Ab12Cd");
      mkdirSync(left);
      writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`);
      personSays("clone notify into the folder beside the workspace");
      const r = utility(["intent", "add-repo", "notify", "--path", join(away, "notify").replace(/\\/g, "/"), "--url", bare], {
        // Claude Code names the chat a command runs in by its id and its own live process.
        CLAUDE_CODE_SESSION_ID: SESSION,
        CLAUDE_PID: String(process.pid),
        CLAUDE_PROJECT_DIR: proj,
      });
      expect(r.rc, r.out).toBe(0);
      const said = `AI-DLC could not remove the temporary folder ${left} it made to clone notify; nothing in it is needed, so you can delete it.`;
      expect(r.out).not.toContain(said);
      const kept = readFileSync(join(proj, "aidlc", ".aidlc-engine", "sessions", `${SESSION}.person-lines`), "utf-8");
      expect(kept).toContain(JSON.stringify(said).slice(1, -1));
      // Kept for the reply: the turn's decision log carries it too, and it is never dropped by age.
      expect((JSON.parse(kept) as { lines: Array<{ line: string; reply?: boolean }> }).lines.find((entry) => entry.line === said)?.reply).toBe(true);
      expect(existsSync(left)).toBe(true);
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
  });

  // The clone's own hook leaves a folder git cannot let go of and fails the
  // clone: the refusal never says nothing was changed while its folder is left.
  // chmod does not lock a file on Windows, and root opens any folder.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a clone that fails and leaves its staging folder: the refusal says nothing in the workspace was changed, then the line",
    () => {
      const bare = bareRepo("local", "notify");
      const away = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-add-away-")));
      const template = join(away, "template");
      mkdirSync(join(template, "hooks"), { recursive: true });
      writeFileSync(join(template, "hooks", "post-checkout"), "#!/bin/sh\nmkdir -p held && echo x > held/f && chmod 555 held\nexit 1\n", {
        mode: 0o755,
      });
      let stage: string | undefined;
      try {
        writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`);
        const r = utility(["intent", "add-repo", "notify", "--path", join(away, "notify").replace(/\\/g, "/"), "--url", bare], {
          GIT_TEMPLATE_DIR: template,
        });
        stage = readdirSync(away).find((name) => name.startsWith(".aidlc-workspace-sync-clone-notify-"));
        expect(r.rc, r.out).not.toBe(0);
        expect(stage, readdirSync(away).join(", ")).toBeDefined();
        expect(r.out).toContain(". Nothing in the workspace was changed. To clone it yourself, run ");
        expect(r.out).not.toContain("Nothing was changed");
        expect(r.out.trim().split("\n").at(-1)).toBe(
          `AI-DLC could not remove the temporary folder ${join(away, stage ?? "")} it made to clone notify; nothing in it is needed, so you can delete it.`,
        );
      } finally {
        const held = join(away, stage ?? "", "notify", "held");
        if (stage !== undefined && existsSync(held)) chmodSync(held, 0o755);
        rmSync(away, { recursive: true, force: true });
      }
    },
  );

  test("--path to a checkout already there with --url: repos.json keeps the address, the credential left out", () => {
    bareRepo("acme", "notify");
    insteadOf("https://user:s3cret-tok@example.invalid/acme/", "acme");
    const address = "https://user:s3cret-tok@example.invalid/acme/notify.git";
    const cloned = spawnSync("git", ["clone", "-q", address, join(proj, "src", "notify")], { encoding: "utf-8", env: gitEnv() });
    expect(cloned.status, cloned.stderr).toBe(0);
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`);
    const r = utility(["intent", "add-repo", "notify", "--path", "src/notify", "--url", address]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain(
      "Added notify to this piece of work's repos. repos.json now lists notify at src/notify. " +
        "Commit it to share it with your team. Its address there leaves out the credential.",
    );
    expect(JSON.parse(readFileSync(join(proj, "repos.json"), "utf-8")).repos).toEqual([
      { name: "app-a" },
      { name: "notify", path: "src/notify", url: "https://example.invalid/acme/notify.git" },
    ]);
    expect(r.out).not.toContain("s3cret-tok");
    expect(audit()).not.toContain("s3cret-tok");
  });

  // x2783-f3 r1a: the agent added two checkouts by their folders with no
  // address given; repos.json listed paths only, so a teammate's clone had
  // nothing to clone them from. The address each one's origin points to is kept.
  test("--path to a checkout with an origin and no --url: repos.json keeps the origin's address, the credential left out", () => {
    const dir = join(proj, "src", "storefront");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", "https://user:s3cret-tok@example.invalid/acme/storefront.git"]);
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`);
    const r = utility(["intent", "add-repo", "storefront", "--path", "src/storefront"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain(
      "repos.json now lists storefront at src/storefront. Commit it to share it with your team. Its address there leaves out the credential.",
    );
    expect(JSON.parse(readFileSync(join(proj, "repos.json"), "utf-8")).repos).toEqual([
      { name: "app-a" },
      { name: "storefront", path: "src/storefront", url: "https://example.invalid/acme/storefront.git" },
    ]);
    expect(r.out).not.toContain("s3cret-tok");
    expect(audit()).not.toContain("s3cret-tok");
  });

  test("--path to a folder in the way with --url: one line names the way on, and nothing changes", () => {
    const bare = bareRepo("local", "notify");
    mkdirSync(join(proj, "src", "notify"), { recursive: true });
    writeFileSync(join(proj, "src", "notify", "notes.txt"), "not a repo\n");
    const raw = `${JSON.stringify({ repos: [{ name: "app-a" }] }, null, 2)}\n`;
    writeFileSync(join(proj, "repos.json"), raw);
    const r = utility(["intent", "add-repo", "notify", "--path", "src/notify", "--url", bare]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain(
      "intent add-repo refused: src/notify is already there and is not a Git checkout, so notify cannot be cloned into it. " +
        "Give another folder, or move that one aside and add it again. Nothing was changed.",
    );
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).toBe(raw);
    expect(repos()).toEqual(["app-a"]);
    expect(stagingLeft()).toEqual([]);
  });
});

// Work that records no repos works on the workspace folder itself (x2783-s11,
// x2783-s6). Before Construction it gains repos where they are, from the folder
// the person named (--path, which repos.json then lists) or where repos.json
// puts them; once Construction has written, its Units' files are read against
// the workspace folder, so add-repo names add-checkout as the way on and that
// lands. Each refusal names a way on, and following it never meets the same
// refusal again.
describe("work that records no repos", () => {
  let beside: string;
  beforeEach(() => {
    resetAidlcEnv();
    gitHome = mkdtempSync(join(tmpdir(), "aidlc-add-repo-git-"));
    gitConfig = join(gitHome, "gitconfig");
    writeFileSync(gitConfig, "[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n");
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    // The lead's workspace is a clone of its own, as a team's is.
    git(proj, ["init", "-q"]);
    recordRepos([]);
    beside = mkdtempSync(join(dirname(proj), "beside-"));
  });

  afterEach(() => {
    cleanupTestProject(proj);
    cleanupTestProject(gitHome);
    cleanupTestProject(beside);
  });

  // A checkout beside the workspace, and the path to it as the person says it.
  function besideRepo(name: string): string {
    const dir = join(beside, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "seed"]);
    return relative(proj, dir).replaceAll("\\", "/");
  }

  // A new list goes in aidlc/, which every test project has.
  function manifest(): { repos: Array<{ name: string; path?: string }> } {
    return JSON.parse(readFileSync(join(proj, "aidlc", "repos.json"), "utf-8"));
  }

  test("repos beside the workspace and no repos.json: the refusal names --path, and the folders the person named are recorded", () => {
    const api = besideRepo("checkout-api");
    const billing = besideRepo("billing");
    const refused = utility(["intent", "add-repo", "checkout-api"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("run this again with --path and the folder the person named");
    expect(repos()).toEqual([]);
    expect(existsSync(join(proj, "repos.json"))).toBe(false);
    const added = utility(["intent", "add-repo", "checkout-api", "--path", api]);
    expect(added.rc, added.out).toBe(0);
    expect(repos()).toEqual(["checkout-api"]);
    expect(added.out).toBe(
      `Added checkout-api (at ${api}) to this piece of work's repos; until now it worked on the workspace folder itself, which it still reads. ` +
        `repos.json is new: it lists checkout-api at ${api}. Commit it to share it with your team. ` +
        "Reverse Engineering will cover checkout-api when it runs. You can remove it again before Construction starts.\n",
    );
    expect(manifest()).toEqual({ repos: [{ name: "checkout-api", path: api }] });
    // workspace-sync's own install: the managed block and the editor's workspace follow repos.json.
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toContain("aidlc workspace-sync managed");
    expect(existsSync(join(proj, "aidlc.code-workspace"))).toBe(true);
    // The second one in its Windows spelling reads the same on every platform.
    const second = utility(["intent", "add-repo", "billing", "--path", billing.replaceAll("/", "\\")]);
    expect(second.rc, second.out).toBe(0);
    expect(repos()).toEqual(["billing", "checkout-api"]);
    expect(second.out).toContain(`Added billing to this piece of work's repos. repos.json now lists billing at ${billing}.`);
    expect(manifest().repos).toEqual([{ name: "checkout-api", path: api }, { name: "billing", path: billing }]);
    // The way on was followed once: the same add says it is done, never the refusal again.
    const again = utility(["intent", "add-repo", "checkout-api"]);
    expect(again.rc, again.out).toBe(0);
    expect(again.out).toContain("checkout-api is already one of this piece of work's repos; nothing changed.");
  });

  test("a repos.json the person wrote with the path: the add needs no flag", () => {
    const api = besideRepo("checkout-api");
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "checkout-api", path: api }] })}\n`);
    const r = utility(["intent", "add-repo", "checkout-api"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["checkout-api"]);
    expect(r.out).toContain(`Added checkout-api (at ${api}) to this piece of work's repos;`);
    expect(r.out).not.toContain("repos.json now lists");
  });

  test("a repo repos.json maps to the workspace folder itself changes nothing", () => {
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "workshop", path: "." }] })}\n`);
    const r = utility(["intent", "add-repo", "workshop"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain("workshop is the workspace folder itself, which this piece of work already works on; nothing changed.");
    expect(repos()).toEqual([]);
    expect(audit()).not.toContain("INTENT_REPOS_CHANGED");
  });

  test("the add's undo before Construction: removing it goes back to the workspace folder", () => {
    const api = besideRepo("checkout-api");
    expect(utility(["intent", "add-repo", "checkout-api", "--path", api]).rc).toBe(0);
    const r = utility(["intent", "remove-repo", "checkout-api"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual([]);
    expect(r.out).toContain("Removed checkout-api from this piece of work's repos; it now works on the workspace folder itself.");
    const none = utility(["intent", "remove-repo", "checkout-api"]);
    expect(none.rc, none.out).toBe(0);
    expect(none.out).toContain("This piece of work records no repos: it works on the workspace folder itself. Nothing changed.");
  });

  test("a --path that is not a checkout, or that repos.json maps elsewhere: nothing is written", () => {
    const api = besideRepo("checkout-api");
    mkdirSync(join(beside, "plain"));
    const plain = relative(proj, join(beside, "plain")).replaceAll("\\", "/");
    const notRepo = utility(["intent", "add-repo", "checkout-api", "--path", plain]);
    expect(notRepo.rc).not.toBe(0);
    expect(notRepo.out).toContain(`${plain} is not a Git checkout (no .git entry there).`);
    expect(existsSync(join(proj, "repos.json"))).toBe(false);
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "checkout-api", path: api }] })}\n`);
    const elsewhere = utility(["intent", "add-repo", "checkout-api", "--path", plain]);
    expect(elsewhere.rc).not.toBe(0);
    expect(elsewhere.out).toContain(`repos.json puts checkout-api at ${api}, not ${plain}.`);
    expect(repos()).toEqual([]);
  });

  test("an absolute --path is said as a path on this machine", () => {
    besideRepo("checkout-api");
    const absolute = join(beside, "checkout-api").replaceAll("\\", "/");
    const r = utility(["intent", "add-repo", "checkout-api", "--path", absolute]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["checkout-api"]);
    expect(r.out).toContain("It is a path on this machine, so a teammate whose copy is elsewhere gives theirs in aidlc/repos.local.json.");
  });

  test("set-repos: the first set before Construction; --all keeps the workspace folder and changes nothing", () => {
    const api = besideRepo("checkout-api");
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "checkout-api", path: api }] })}\n`);
    const all = utility(["intent", "set-repos", "--all"]);
    expect(all.rc, all.out).toBe(0);
    expect(all.out).toContain("This piece of work records no repos: it works on the workspace folder itself. Nothing changed.");
    const set = utility(["intent", "set-repos", "checkout-api"]);
    expect(set.rc, set.out).toBe(0);
    expect(repos()).toEqual(["checkout-api"]);
  });

  test("x2783-s6: after the Units exist, mid-Construction, a Unit that also changes a repo beside the workspace: add-checkout is the way on, and the earlier Unit's files read as before", () => {
    const docs = besideRepo("tally-docs");
    writeFileSync(join(proj, "repos.json"), `${JSON.stringify({ repos: [{ name: "tally-docs", path: docs }] })}\n`);
    unitsApproved("relaxed");
    // The first Unit's Code Generation wrote the workshop's own code, in the workspace folder.
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "list.ts"), "export const list = 1;\n");
    const stage = join(seededRecordDir(proj), "construction", "alpha", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "src/list.ts" }] })}\n`);
    const before = readUnitSourceManifest(proj, "code-generation", "alpha");
    expect(before.ok).toBe(true);
    const refused = utility(["intent", "add-repo", "tally-docs"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain(
      "intent add-repo refused: this piece of work keeps its code in the workspace folder itself and Construction has started, " +
        "so it records no repos from here. To have the review and its checks cover tally-docs too, run `",
    );
    expect(refused.out).toContain(`intent add-checkout ${docs}\``);
    expect(repos()).toEqual([]);
    // The way on lands, and the earlier Unit's files are read as they were.
    const checkout = utility(["intent", "add-checkout", docs]);
    expect(checkout.rc, checkout.out).toBe(0);
    expect(checkout.out).toContain(`Recorded ${docs} for this piece of work's review`);
    expect(readUnitSourceManifest(proj, "code-generation", "alpha")).toEqual(before);
    expect(repos()).toEqual([]);
    const set = utility(["intent", "set-repos", "tally-docs"]);
    expect(set.rc).not.toBe(0);
    expect(set.out).toContain("intent set-repos refused: this piece of work keeps its code in the workspace folder itself");
  });
});
