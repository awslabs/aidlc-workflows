// covers: cli:aidlc-utility(intent add-repo, intent remove-repo, intent set-repos), function:handleIntentRepos, function:plannedRepoClone, function:unitsRepoChangeAtChange, function:stageWorkspaceRepo, function:installWorkspaceRepo, function:workspaceManifestWith, function:hostedAddressOwner, function:withoutCredentials
//
// A piece of work that already records sibling repos gains or loses one, at any
// stage. The engine checks the name and the folder (a real .git entry, which a
// commit can never carry), clones a repo that is not here yet the way
// workspace-sync does and with the person's own git setup, writes repos.json,
// records INTENT_REPOS_CHANGED, then the registry row, and says one line. After
// Units Generation is approved the change lands too: relaxed or off record it
// as accepted with one line; strict leaves the question to the next step.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function utility(args: string[]): { rc: number; out: string } {
  const r = spawnSync(process.execPath, [UTIL, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: gitEnv(),
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
    expect(r.out).toContain("is not a Git checkout under the workspace folder");
    expect(repos()).toEqual(["app-a"]);
  });

  test("refuses when the piece of work records no repos: the workspace folder is its repo", () => {
    recordRepos([]);
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("treats the workspace folder itself as its code repo");
    expect(repos()).toEqual([]);
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

  test("from the repos.json org, through the person's own git config: installed, listed, recorded, said", () => {
    bareRepo("acme", "payments");
    insteadOf("git@github.com:acme/", "acme");
    writeFileSync(
      join(proj, "repos.json"),
      '{\n  // the team\'s repos\n  "org": "acme",\n  "repos": [\n    { "name": "app-a" }\n  ]\n}\n',
    );
    const r = utility(["intent", "add-repo", "payments", "--reason", "the consent API lives in payments"]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out.trim()).toBe(
      "Cloned payments from git@github.com:acme/payments.git and added it to this piece of work's repos. " +
        "repos.json now lists it. Reverse Engineering will cover payments when it runs. You can remove it again any time.",
    );
    expect(existsSync(join(proj, "payments", "src", "api.ts"))).toBe(true);
    expect(repos()).toEqual(["app-a", "payments"]);
    const manifest = readFileSync(join(proj, "repos.json"), "utf-8");
    expect(manifest).toContain("// the team's repos");
    expect(manifest).toContain('"name": "payments"');
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
    const manifest = JSON.parse(readFileSync(join(proj, "repos.json"), "utf-8"));
    expect(manifest).toEqual({ org: "acme", repos: [{ name: "payments", url: "https://example.invalid/acme/payments.git" }] });
    expect(r.out).not.toContain("s3cret-tok");
    expect(audit()).not.toContain("s3cret-tok");
    expect(audit()).toContain("**Person Words**: add payments from https://***@example.invalid/acme/payments.git");
    expect(readFileSync(join(proj, "repos.json"), "utf-8")).not.toContain("s3cret-tok");
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
    expect(r.out).toContain(
      "payments is not in this workspace yet, and there is no repos.json with an org to clone it from. " +
        "Give its clone address with --url, or clone it beside the other repos, then add it again.",
    );
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
});
