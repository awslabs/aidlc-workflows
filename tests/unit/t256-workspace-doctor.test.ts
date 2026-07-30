// t256-workspace-doctor: the workspace-manifest --doctor rows are advisory,
// manifest-gated, and read the same on-disk sibling set the runtime uses.
//
// covers: file:core/tools/aidlc-workspace-doctor.ts
//
// The contract these workspace-doctor rows must hold:
//   - EVERY row is advisory (pass:true) - they never flip doctor's exit code.
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

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceManifestChecks } from "../../core/tools/aidlc-workspace-doctor.ts";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

// A workspace root that is a real git repo (so the W1 `git status -- aidlc`
// probe runs its real path rather than the not-a-git-repo skip).
function freshGitWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t256-"));
  tmpRoots.push(dir);
  const g = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
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

// Assert the load-bearing invariant on any set of rows: nothing is ever a fail.
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
    spawnSync("git", ["-C", ws, "config", "status.showUntrackedFiles", "no"]);
    mkdirSync(join(ws, "aidlc"), { recursive: true });
    writeFileSync(join(ws, "aidlc", "note.md"), "unstaged\n", "utf-8");
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    expect(rows[0].label).toContain("uncommitted change(s) under aidlc/");
    // The advisory hint names the git remedy, not any fork-specific infra.
    expect(rows[0].label).toContain("git add aidlc/");
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

  test("W2 reports drift both ways: declared-but-not-cloned AND on-disk-but-undeclared", () => {
    const ws = freshGitWorkspace();
    // Manifest declares checkout-api + checkout-web; disk has checkout-api +
    // an undeclared 'legacy-svc'. So checkout-web is declared-but-not-cloned
    // and legacy-svc is on-disk-but-undeclared.
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "legacy-svc");
    const rows = workspaceManifestChecks(ws);
    expectAllAdvisory(rows);
    const repos = rows.find((r) => r.label.includes("Workspace repos"));
    expect(repos?.label).toContain("drift");
    expect(repos?.label).toContain("checkout-web"); // declared but not cloned
    expect(repos?.label).toContain("legacy-svc"); // on disk but not declared
    // W2 fix-text names the sync tool for the not-cloned side.
    expect(repos?.label).toContain("aidlc-workspace-sync.ts");
  });

  test("W3 detects a managed block that no longer matches the manifest", () => {
    const ws = freshGitWorkspace();
    writeManifest(ws, MANIFEST);
    makeSibling(ws, "checkout-api");
    makeSibling(ws, "checkout-web");
    // A managed block listing a stale set (missing checkout-web).
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
