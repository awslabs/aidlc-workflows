// t256-workspace-doctor: the workspace-manifest --doctor rows are advisory,
// manifest-gated, and read the same on-disk sibling set the runtime uses.
//
// covers: file:core/tools/aidlc-workspace-doctor.ts, file:core/tools/aidlc-gitignore.ts
//
// The contract these workspace-doctor rows must hold:
//   - Advisory drift uses severity warn and never flips doctor's exit code.
//   - W1 (uncommitted records under aidlc/) runs in any git workspace and
//     overrides status.showUntrackedFiles so user config cannot hide records.
//   - W2 (repos.json vs on-disk sibling drift) + W3 (stale managed .gitignore
//     block) run ONLY when a repos.json manifest is present, so a single-repo
//     install gets no manifest-specific rows (no repos.json → exactly W1).
//   - W2 reports drift both ways (declared-but-not-cloned, on-disk-but-undeclared)
//     and W3 detects a managed block that no longer matches the manifest.
//
// Mechanism: call workspaceManifestChecks() directly against throwaway git
// workspaces built with real `git init` (offline). Zero LLM.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { workspaceManifestChecks } from "../../core/tools/aidlc-workspace-doctor.ts";
import {
  REPO_ROOT,
  seedAuditFile,
  seededAuditDir,
  seededAuditShard,
  seedStateFile,
  seedWorkspaceShell,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

// A workspace root that is a real git repo (so the W1 `git status -- aidlc`
// probe runs its real path rather than the not-a-git-repo skip).
function freshGitWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t256-"));
  tmpRoots.push(dir);
  const g = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t256@example.com");
  g("config", "user.name", "t256");
  return dir;
}

// Make a directory look like a cloned sibling repo (a child dir holding .git),
// which is exactly what discoverSiblingRepos scans for.
function makeSibling(root: string, name: string): void {
  mkdirSync(join(root, name, ".git"), { recursive: true });
}

function writeManifest(root: string, body: string): void {
  writeFileSync(join(root, "repos.json"), body, "utf-8");
}

// Assert the load-bearing invariant on rows that represent healthy or skipped state.
function expectAllAdvisory(rows: Array<{ pass: boolean; label: string }>): void {
  for (const r of rows) expect(r.pass).toBe(true);
}

const MANIFEST = `{
  // team repos
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" },
    { "name": "checkout-web" }
  ]
}
`;

describe("t256 workspace-doctor - advisory manifest rows", () => {
  test("no repos.json → only the W1 records row, and it is advisory", () => {
    const ws = freshGitWorkspace();
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    // A workspace without a manifest gets exactly W1, with no W2/W3.
    expect(rows.length).toBe(1);
    expect(rows[0].label).toContain("Workspace records");
    expect(rows.some((r) => r.label.includes("Workspace repos"))).toBe(false);
    expect(rows.some((r) => r.label.includes("Workspace .gitignore"))).toBe(false);
  });

  test("clean git workspace with no uncommitted aidlc/ changes → W1 reports clean", () => {
    const ws = freshGitWorkspace();
    const rows = workspaceManifestChecks(ws);
    expect(rows[0].pass).toBe(true);
    expect(rows[0].label).toContain("no uncommitted changes under aidlc/");
  });

  test("uncommitted files under aidlc/ → W1 surfaces the count (advisory)", () => {
    const ws = freshGitWorkspace();
    // W1 must override this user setting or it falsely reports a clean records tree.
    spawnSync("git", ["-C", ws, "config", "status.showUntrackedFiles", "no"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    mkdirSync(join(ws, "aidlc"), { recursive: true });
    writeFileSync(join(ws, "aidlc", "note.md"), "unstaged\n", "utf-8");
    const rows = workspaceManifestChecks(ws);
    expect(rows[0].pass).toBe(false);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].label).toContain("uncommitted change(s) under aidlc/");
    // The advisory hint names the git remedy, not any fork-specific infra.
    expect(rows[0].label).toContain("git add aidlc/");
  });

  // A request committed before the folder was ignored stays tracked: W1 leaves
  // it out of the records to commit, and doctor names the step that takes it
  // out of git without running it.
  test("a committed request file is left out of W1 and named with the step that untracks it", () => {
    const ws = freshGitWorkspace();
    const g = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    mkdirSync(join(ws, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "request.txt"), "my first words\n", "utf-8");
    g("add", "aidlc");
    g("commit", "-q", "-m", "earlier commit");
    // The folder is ignored now and a later request changes the tracked file.
    writeFileSync(join(ws, ".gitignore"), "aidlc/.aidlc-request-text/\n", "utf-8");
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "request.txt"), "my later words\n", "utf-8");
    const rows = workspaceManifestChecks(ws);
    expect(rows[0].label).toContain("no uncommitted changes under aidlc/");
    const request = rows.find((r) => r.label.startsWith("Request folder:"));
    expect(request).toMatchObject({ pass: false, severity: "warn" });
    expect(request?.label).toContain("files in aidlc/.aidlc-request-text/ hold your own requests (1 that git tracks)");
    expect(request?.fix).toContain("in the project folder, take the tracked ones out of git, keeping the files: `git rm --cached -r -f -- aidlc/.aidlc-request-text/`, then commit and push the removal, with .gitignore if its change is not committed yet");
    // The folder is ignored already, so no ignore line is asked for.
    expect(request?.fix).not.toContain("add the line");
    // While the request row stands, the records row gives no commit command:
    // `git add aidlc/` would take the tracked request in.
    writeFileSync(join(ws, "aidlc", "note.md"), "a record\n", "utf-8");
    const recordsRow = workspaceManifestChecks(ws)[0];
    const records = recordsRow.label;
    expect(records).toContain("1 uncommitted change(s) under aidlc/");
    expect(records).toContain("once the request folder steps below are done");
    expect(records).not.toContain("git add aidlc/");
    // Its own fix, so doctor adds no generic fallback under it.
    expect(recordsRow.fix).toBe("do the request folder steps below first; then this row names the commit");
    // Doctor only names the step: the file is still tracked and unchanged.
    expect(g("ls-files", "--", "aidlc/.aidlc-request-text").stdout.trim()).toBe("aidlc/.aidlc-request-text/request.txt");
    expect(readFileSync(join(ws, "aidlc", ".aidlc-request-text", "request.txt"), "utf-8")).toBe("my later words\n");
  });

  test("a request folder an older .gitignore does not ignore is named with the ignore line first", () => {
    const ws = freshGitWorkspace();
    const g = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    mkdirSync(join(ws, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "request.txt"), "my words\n", "utf-8");
    // Untracked and not ignored: the ignore line is the step.
    const rows = workspaceManifestChecks(ws);
    let request = rows.find((r) => r.label.startsWith("Request folder:"));
    expect(request?.label).toContain("hold your own requests (1 not ignored)");
    expect(request?.fix).toBe("add the line `aidlc/.aidlc-request-text/` to the project folder's .gitignore, and check no later rule of yours un-ignores it, then commit and push the .gitignore change");
    expect(request?.fix).not.toContain("git rm --cached");
    // The workspace row never asks to commit it.
    expect(rows[0].label).toContain("no uncommitted changes under aidlc/");
    // Tracked and not ignored: the ignore line first, then untrack.
    g("add", "aidlc");
    g("commit", "-q", "-m", "earlier commit");
    request = workspaceManifestChecks(ws).find((r) => r.label.startsWith("Request folder:"));
    expect(request?.fix).toMatch(/^add the line `aidlc\/\.aidlc-request-text\/` to the project folder's \.gitignore, .*, then in the project folder, take the tracked ones out of git, keeping the files: `git rm --cached -r -f -- aidlc\/\.aidlc-request-text\/`/);
  });

  test("a project below its repository root, and a request named with a space and Korean, are never asked to be committed", () => {
    const repo = freshGitWorkspace();
    const project = join(repo, "app");
    mkdirSync(join(project, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(project, "aidlc", ".aidlc-request-text", "내 요청 1.txt"), "my words\n", "utf-8");
    const rows = workspaceManifestChecks(project);
    expect(rows[0].label).toContain("no uncommitted changes under aidlc/");
    expect(rows.find((r) => r.label.startsWith("Request folder:"))?.label).toContain("(1 not ignored)");
  });

  test("a request taken out of git but not committed yet is still named, with commit and push", () => {
    const ws = freshGitWorkspace();
    const g = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    mkdirSync(join(ws, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "request.txt"), "my words\n", "utf-8");
    g("add", "aidlc");
    g("commit", "-q", "-m", "earlier commit");
    writeFileSync(join(ws, ".gitignore"), "aidlc/.aidlc-request-text/\n", "utf-8");
    // The step the row named, run by the person.
    expect(g("rm", "--cached", "-r", "-f", "-q", "--", "aidlc/.aidlc-request-text/").status).toBe(0);
    const request = workspaceManifestChecks(ws).find((r) => r.label.startsWith("Request folder:"));
    expect(request?.label).toContain("(1 taken out of git, not committed yet)");
    expect(request?.fix).toBe("commit and push the removal, with .gitignore if its change is not committed yet");
    // With only the removal left, the records row gives its command again.
    writeFileSync(join(ws, "aidlc", "note.md"), "a record\n", "utf-8");
    expect(workspaceManifestChecks(ws)[0].label).toContain("`git add aidlc/ && git commit && git push`");
    rmSync(join(ws, "aidlc", "note.md"));
    g("commit", "-q", "-m", "untrack the request");
    expect(workspaceManifestChecks(ws).some((r) => r.label.startsWith("Request folder:"))).toBe(false);
  });

  test("doctor run from another folder shows the steps as the fix, with the line to add", () => {
    const project = freshGitWorkspace();
    cpSync(join(REPO_ROOT, "dist", "claude"), project, { recursive: true });
    // A .gitignore part from before the request folder was ignored.
    const gitignore = join(project, ".gitignore");
    writeFileSync(gitignore, readFileSync(gitignore, "utf-8").replace("aidlc/.aidlc-request-text/\n", ""), "utf-8");
    mkdirSync(join(project, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(project, "aidlc", ".aidlc-request-text", "request.txt"), "my words\n", "utf-8");
    const elsewhere = mkdtempSync(join(tmpdir(), "aidlc-t256-elsewhere-"));
    tmpRoots.push(elsewhere);
    const doctor = spawnSync(process.execPath, [join(project, ".claude", "tools", "aidlc-doctor.ts"), "--project-dir", project], {
      cwd: elsewhere,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const out = `${doctor.stdout}${doctor.stderr}`;
    const row = out.split("\n").findIndex((line) => line.includes("Request folder:"));
    expect(row, out).toBeGreaterThan(-1);
    const fix = out.split("\n")[row + 1] ?? "";
    expect(fix, out).toContain("add the line `aidlc/.aidlc-request-text/` to the project folder's .gitignore");
    expect(fix, out).not.toContain("add --verbose");
  });

  test("a request taken out of git before the folder is ignored counts once and keeps the ignore step", () => {
    const repo = freshGitWorkspace();
    const g = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    const project = join(repo, "app");
    mkdirSync(join(project, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(project, "aidlc", ".aidlc-request-text", "request.txt"), "my words\n", "utf-8");
    g("add", "app");
    g("commit", "-q", "-m", "earlier commit");
    expect(g("rm", "--cached", "-r", "-f", "-q", "--", "app/aidlc/.aidlc-request-text/").status).toBe(0);
    const request = workspaceManifestChecks(project).find((r) => r.label.startsWith("Request folder:"));
    expect(request?.label).toContain("hold your own requests (1 taken out of git, not committed yet)");
    expect(request?.fix).toMatch(/^add the line `aidlc\/\.aidlc-request-text\/` to the project folder's \.gitignore, .*, then commit and push the removal and the \.gitignore change$/);
    // The removed file is still on disk and not ignored: `git add aidlc/` would take it back in.
    writeFileSync(join(project, "aidlc", "note.md"), "a record\n", "utf-8");
    const records = workspaceManifestChecks(project)[0].label;
    expect(records).toContain("1 uncommitted change(s) under aidlc/");
    expect(records).not.toContain("git add aidlc/");
  });

  test("every tracked request is tried against the ignore rules, not only the first", () => {
    const ws = freshGitWorkspace();
    const g = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    mkdirSync(join(ws, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "a.txt"), "first\n", "utf-8");
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "b.md"), "second\n", "utf-8");
    g("add", "aidlc");
    g("commit", "-q", "-m", "earlier commit");
    // A narrower rule ignores one of the two.
    writeFileSync(join(ws, ".gitignore"), "aidlc/.aidlc-request-text/*.txt\n", "utf-8");
    const request = workspaceManifestChecks(ws).find((r) => r.label.startsWith("Request folder:"));
    expect(request?.label).toContain("(2 that git tracks)");
    expect(request?.fix).toContain("add the line `aidlc/.aidlc-request-text/` to the project folder's .gitignore");
  });

  test("an ignored, untracked request file gets no row, and other aidlc/ changes still count", () => {
    const ws = freshGitWorkspace();
    writeFileSync(join(ws, ".gitignore"), "aidlc/.aidlc-request-text/\n", "utf-8");
    mkdirSync(join(ws, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(ws, "aidlc", ".aidlc-request-text", "request.txt"), "my words\n", "utf-8");
    expect(workspaceManifestChecks(ws).some((r) => r.label.startsWith("Request folder:"))).toBe(false);
    writeFileSync(join(ws, "aidlc", "note.md"), "a record\n", "utf-8");
    const rows = workspaceManifestChecks(ws);
    expect(rows[0].label).toContain("1 uncommitted change(s) under aidlc/");
    expect(rows.some((r) => r.label.startsWith("Request folder:"))).toBe(false);
  });

  test("doctor warns when a later user rule hides committed records, without changing its exit code", () => {
    const ws = freshGitWorkspace();
    const env = {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(ws, "machine", "share"),
      AIDLC_BIN_DIR: join(ws, "machine", "bin"),
      NO_COLOR: "1",
    };
    const configured = spawnSync(process.execPath, [
      join(REPO_ROOT, "core", "tools", "aidlc-init.ts"),
      "config", "--project-dir", ws, "--from", join(REPO_ROOT, "dist-release", "claude"),
      "--harness", "claude", "--mcp", "none",
    ], { cwd: ws, env, encoding: "utf-8" });
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const doctor = () => spawnSync(process.execPath, [
      join(ws, ".claude", "tools", "aidlc-utility.ts"),
      "doctor", "--verbose", "--project-dir", ws,
    ], { cwd: ws, env, encoding: "utf-8" });
    const before = doctor();
    expect(before.stdout + before.stderr).not.toContain("Workspace record visibility:");

    const path = join(ws, ".gitignore");
    const line = readFileSync(path, "utf-8").split("\n").length;
    appendFileSync(path, "aidlc/\n");
    const rows = workspaceManifestChecks(ws);
    const row = rows.find((result) => result.label.startsWith("Workspace record visibility:"));
    expect(row?.pass).toBe(false);
    expect(row?.severity).toBe("warn");
    expect(row?.label).toContain(`.gitignore:${line} hides committed workflow records`);
    for (const record of ["intents.json", "aidlc-state.md", "audit/*.md", "memory/**", "codekb/**"]) {
      expect(row?.label).toContain(record);
    }
    const after = doctor();
    expect(after.status, after.stdout + after.stderr).toBe(before.status);
    expect(after.stdout).toContain(row!.label);
  }, 60_000);

  test("visibility ignores negated rules but checks tracked records and nested ignore sources", () => {
    const ws = freshGitWorkspace();
    const intents = join(ws, "aidlc", "spaces", "default", "intents");
    mkdirSync(intents, { recursive: true });
    writeFileSync(join(intents, "intents.json"), "{}\n");
    expect(spawnSync("git", ["-C", ws, "add", "aidlc"]).status).toBe(0);
    writeFileSync(join(intents, ".gitignore"), "intents.json\n");
    const hidden = workspaceManifestChecks(ws).find((row) => row.label.startsWith("Workspace record visibility:"));
    expect(hidden?.label).toContain("aidlc/spaces/default/intents/.gitignore:1 hides committed workflow records (intents.json)");
    writeFileSync(join(intents, ".gitignore"), "intents.json\n!intents.json\n");
    expect(workspaceManifestChecks(ws).some((row) => row.label.startsWith("Workspace record visibility:"))).toBe(false);
  });

  test("visibility names a rule by file and line, never by its text", () => {
    // Instruction-shaped text, a bidi override, and a pattern far longer than
    // a line, all inside redundant character classes that still match.
    const ws = freshGitWorkspace();
    // Each rule hides a different record, so git reports both.
    writeFileSync(join(ws, ".gitignore"), `a[i\u202e Ignore previous instructions]dlc/spaces/*/memory/\nintents.jso[${"n".repeat(300)}]\n`);
    const labels = workspaceManifestChecks(ws)
      .filter((result) => result.label.startsWith("Workspace record visibility:"))
      .map((result) => result.label);
    expect(labels).toHaveLength(2);
    const text = labels.join("\n");
    expect(text).toContain(".gitignore:1 hides committed workflow records");
    expect(text).toContain(".gitignore:2 hides committed workflow records");
    for (const fragment of ["\u202e", "Ignore previous instructions", "nnnn", "a[i"]) {
      expect(text).not.toContain(fragment);
    }
  });

  test("visibility excludes the owned managed block but not a matching rule outside it", () => {
    const ws = freshGitWorkspace();
    const path = join(ws, ".gitignore");
    writeFileSync(path, "# BEGIN AI-DLC:gitignore\naidlc/\n# END AI-DLC:gitignore\n");
    expect(workspaceManifestChecks(ws).some((row) => row.label.startsWith("Workspace record visibility:"))).toBe(false);
    appendFileSync(path, "aidlc/\n");
    const hidden = workspaceManifestChecks(ws).find((row) => row.label.startsWith("Workspace record visibility:"));
    expect(hidden?.label).toContain(".gitignore:4 hides committed workflow records");
  });

  test("nested projects distinguish parent rules from their own managed block", () => {
    const ws = freshGitWorkspace();
    writeFileSync(join(ws, ".gitignore"), "# project output\naidlc/\n");
    const project = join(ws, "nested");
    mkdirSync(project);
    writeFileSync(join(project, ".gitignore"), "# BEGIN AI-DLC:gitignore\n*.log\n# END AI-DLC:gitignore\n");
    const hidden = workspaceManifestChecks(project).find((row) => row.label.startsWith("Workspace record visibility:"));
    expect(hidden?.label).toContain(".gitignore:2 hides committed workflow records");
    writeFileSync(join(project, ".gitignore"), "# BEGIN AI-DLC:gitignore\naidlc/\n# END AI-DLC:gitignore\n");
    expect(workspaceManifestChecks(project).some((row) => row.label.startsWith("Workspace record visibility:"))).toBe(false);
  });

  // Git does not follow a symlinked .gitignore, so a nested rule still
  // matches; the doctor must not then open the link's target, which blocks
  // for a FIFO. A child process bounds the wait if it ever does.
  test.skipIf(process.platform === "win32")("a symlinked root .gitignore is skipped, not read", () => {
    const ws = freshGitWorkspace();
    const fifo = join(mkdtempSync(join(tmpdir(), "aidlc-t256-fifo-")), "pipe");
    tmpRoots.push(dirname(fifo));
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    symlinkSync(fifo, join(ws, ".gitignore"));
    const intents = join(ws, "aidlc", "spaces", "default", "intents");
    mkdirSync(intents, { recursive: true });
    writeFileSync(join(intents, ".gitignore"), "intents.json\n");
    const doctor = join(REPO_ROOT, "core", "tools", "aidlc-workspace-doctor.ts");
    const result = spawnSync(process.execPath, [
      "-e",
      `import { workspaceManifestChecks } from ${JSON.stringify(doctor)};
       console.log(JSON.stringify(workspaceManifestChecks(${JSON.stringify(ws)}).map((row) => row.label)));`,
    ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    expect(result.status, `${result.error ?? ""}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(expect.stringContaining(
      "aidlc/spaces/default/intents/.gitignore:1 hides committed workflow records (intents.json)",
    ));
  });

  test("manifest present, disk matches → W2 in-sync + W3 match, all advisory", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "checkout-web");
    // A managed .gitignore block matching the manifest (sorted /{name}/ lines).
    writeFileSync(
      join(ws, ".gitignore"),
      "# >>> aidlc workspace-sync managed (do not edit inside; regenerated from repos.json) >>>\n" +
        "/.aidlc-workspace-sync-recovery-*/\n" +
        "/checkout-api/\n/checkout-web/\n" +
        "# <<< aidlc workspace-sync managed <<<\n",
      "utf-8",
    );
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    const repos = rows.find((r) => r.label.includes("Workspace repos"));
    const gi = rows.find((r) => r.label.includes("Workspace .gitignore"));
    expect(repos?.label).toContain("in sync");
    expect(gi?.label).toContain("matches repos.json");
    expect(gi?.label).toContain("2 repo dir(s)");
  });

  test("a repo folder named with a space is in sync, and its managed line matches", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, '{ "org": "acme", "repos": [{ "name": "my lib" }, { "name": "checkout-api" }] }');
    makeSibling(ws, "my lib");
    makeSibling(ws, "checkout-api");
    writeFileSync(
      join(ws, ".gitignore"),
      "# >>> aidlc workspace-sync managed (do not edit inside; regenerated from repos.json) >>>\n" +
        "/.aidlc-workspace-sync-recovery-*/\n" +
        "/checkout-api/\n/my lib/\n" +
        "# <<< aidlc workspace-sync managed <<<\n",
      "utf-8",
    );
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    expect(rows.find((r) => r.label.includes("Workspace repos"))?.label).toContain("in sync");
    expect(rows.find((r) => r.label.includes("Workspace .gitignore"))?.label).toContain("matches repos.json");
  });

  test("W3: a block that also ignores the clone staging folder matches repos.json too", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "checkout-web");
    writeFileSync(
      join(ws, ".gitignore"),
      "# >>> aidlc workspace-sync managed (do not edit inside; regenerated from repos.json) >>>\n" +
        "/.aidlc-workspace-sync-recovery-*/\n" +
        "/.aidlc-workspace-sync-txn-*/\n" +
        "/checkout-api/\n/checkout-web/\n" +
        "# <<< aidlc workspace-sync managed <<<\n",
      "utf-8",
    );
    const gi = workspaceManifestChecks(ws).find((r) => r.label.includes("Workspace .gitignore"));
    expect(gi?.label).toContain("matches repos.json");
  });

  test("W2 reports drift both ways: declared-but-not-cloned AND on-disk-but-undeclared", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "legacy-svc");
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    const repos = rows.find((r) => r.label.includes("Workspace repos"));
    expect(repos?.label).toContain("drift");
    expect(repos?.label).toContain("checkout-web"); // declared but not cloned
    expect(repos?.label).toContain("legacy-svc"); // on disk but not declared
    expect(repos?.label).toContain("aidlc-workspace-sync.ts");
  });

  test("W3 detects a managed block that no longer matches the manifest", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "checkout-web");
    writeFileSync(
      join(ws, ".gitignore"),
      "# >>> aidlc workspace-sync managed (do not edit inside; regenerated from repos.json) >>>\n" +
        "/.aidlc-workspace-sync-recovery-*/\n" +
        "/checkout-api/\n" +
        "# <<< aidlc workspace-sync managed <<<\n",
      "utf-8",
    );
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    const gi = rows.find((r) => r.label.includes("Workspace .gitignore"));
    expect(gi?.label).toContain("stale vs repos.json");
    expect(gi?.label).toContain("aidlc-workspace-sync.ts");
  });

  test("W3 reports the missing managed block when repos.json exists but .gitignore has none", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "checkout-web");
    // No .gitignore at all.
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    const gi = rows.find((r) => r.label.includes("Workspace .gitignore"));
    expect(gi?.label).toContain("managed block missing");
  });

  test("unparseable repos.json → advisory row, never a fail, and no crash", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, "{ this is not json ]");
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    expect(rows.some((r) => r.label.includes("unparseable"))).toBe(true);
  });

  test("schema-invalid repos.json is not reported as synchronized", () => {
    for (const body of [
      '{ "repos": [{ "name": "checkout-api" }] }',
      '{ "org": "acme", "repos": [{ "name": "../escaped" }] }',
      '{ "org": "acme", "repos": [{ "name": "api", "branch": "" }] }',
      '{ "org": "acme", "repos": [{ "name": "api" }, { "name": "api" }] }',
    ]) {
      const ws = freshGitWorkspace();
      writeManifest(ws, body);
      const rows = workspaceManifestChecks(ws);
      expectAllAdvisory(rows);
      const repos = rows.find((row) => row.label.includes("Workspace repos"));
      expect(repos?.label).toContain("invalid");
      expect(repos?.label).not.toContain("in sync");
    }
  });
});

// Every doctor run in a project with an audit trail writes its own entries
// (Guardrail Loaded, Health Check) into this clone's audit log. Those entries
// are doctor's receipt, not records a teammate needs, so the next run must not
// count them as uncommitted records and tell the person to commit and push.
describe("t256 workspace-doctor - doctor's own audit log entries", () => {
  // A committed project laid out as the Claude install lays it out (managed
  // .gitignore included), with an intent whose audit log is committed.
  function committedProject(prepare?: (ws: string) => void, folder = ""): { ws: string; g: (...args: string[]) => ReturnType<typeof spawnSync> } {
    const repo = freshGitWorkspace();
    const ws = folder ? join(repo, folder) : repo;
    const g = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    cpSync(join(REPO_ROOT, "dist", "claude"), ws, { recursive: true });
    seedWorkspaceShell(ws);
    seedAuditFile(ws);
    seedStateFile(ws, "state-mid-ideation.md");
    prepare?.(ws);
    g("add", "-A");
    g("commit", "-q", "-m", "clean project");
    expect(g("status", "--porcelain").stdout).toBe("");
    return { ws, g };
  }

  function doctorRecordsRow(ws: string): { pass: boolean; severity?: string; label: string } {
    const run = spawnSync(process.execPath, [join(ws, ".claude", "tools", "aidlc-doctor.ts"), "--json", "--project-dir", ws], {
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const checks = (JSON.parse(run.stdout) as { data: { checks: Array<{ pass: boolean; severity?: string; label: string }> } }).data.checks;
    const row = checks.find((check) => check.label.startsWith("Workspace records:"));
    expect(row, run.stdout).toBeDefined();
    return row as { pass: boolean; severity?: string; label: string };
  }

  const OWN_ENTRIES_ONLY = "Workspace records: no uncommitted changes under aidlc/ other than doctor's own entries in the audit log";
  const STAGE_ROW = "\n## Stage Started\n**Timestamp**: 2026-10-20T01:00:00Z\n**Event**: STAGE_STARTED\n**Stage**: requirements-analysis\n\n---\n";

  test("a clean project run through doctor twice is not told to commit doctor's own entries", () => {
    const { ws, g } = committedProject();
    expect(doctorRecordsRow(ws).label).toBe("Workspace records: no uncommitted changes under aidlc/");
    const second = doctorRecordsRow(ws);
    // Doctor still keeps its receipt: the audit log is the one changed file.
    const shard = seededAuditShard(ws).slice(ws.length + 1).replaceAll("\\", "/");
    expect(g("status", "--porcelain").stdout).toBe(` M ${shard}\n`);
    expect(second).toEqual({ pass: true, label: OWN_ENTRIES_ONLY });
  });

  test("a record of the person's work is still counted, in its own file or next to doctor's entries", () => {
    const { ws } = committedProject();
    doctorRecordsRow(ws);
    writeFileSync(join(ws, "aidlc", "note.md"), "a record\n", "utf-8");
    let row = workspaceManifestChecks(ws)[0];
    expect(row).toMatchObject({ pass: false, severity: "warn" });
    expect(row.label).toContain("Workspace records: 1 uncommitted change(s) under aidlc/");
    appendFileSync(seededAuditShard(ws), STAGE_ROW, "utf-8");
    row = workspaceManifestChecks(ws)[0];
    expect(row.label).toContain("Workspace records: 2 uncommitted change(s) under aidlc/");
    expect(row.label).toContain("`git add aidlc/ && git commit && git push`");
  });

  test("a clone whose audit log doctor started, beside a teammate's, is not told to commit it", () => {
    const { ws, g } = committedProject((dir) => {
      renameSync(seededAuditShard(dir), join(seededAuditDir(dir), "teammate-box-0123456789abcdef.md"));
    });
    doctorRecordsRow(ws);
    const own = basename(seededAuditShard(ws));
    expect(g("status", "--porcelain").stdout).toContain(`?? ${seededAuditShard(ws).slice(ws.length + 1).replaceAll("\\", "/")}`);
    expect(readFileSync(seededAuditShard(ws), "utf-8")).toStartWith("# AI-DLC Audit Log\n");
    expect(workspaceManifestChecks(ws)[0], own).toEqual({ pass: true, label: OWN_ENTRIES_ONLY });
    appendFileSync(seededAuditShard(ws), STAGE_ROW, "utf-8");
    expect(workspaceManifestChecks(ws)[0].label).toContain("Workspace records: 1 uncommitted change(s) under aidlc/");
  });

  test("a project below its repository root is read the same way", () => {
    const { ws } = committedProject(undefined, "app");
    doctorRecordsRow(ws);
    expect(workspaceManifestChecks(ws)[0]).toEqual({ pass: true, label: OWN_ENTRIES_ONLY });
  });

  test("an audit log checked out with Windows line endings is read the same way", () => {
    const { ws, g } = committedProject();
    const shard = seededAuditShard(ws);
    g("config", "core.autocrlf", "true");
    rmSync(shard);
    expect(g("checkout", "--", shard.slice(ws.length + 1).replaceAll("\\", "/")).status).toBe(0);
    expect(readFileSync(shard, "utf-8")).toContain("\r\n");
    doctorRecordsRow(ws);
    expect(workspaceManifestChecks(ws)[0]).toEqual({ pass: true, label: OWN_ENTRIES_ONLY });
  });
});
