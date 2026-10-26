// covers: function:folderRepoName, function:codekbRepoName, function:sourceCheckoutLabelFor, subcommand:aidlc-utility:codekb-path, subcommand:aidlc-utility:codekb-snapshot, subcommand:aidlc-utility:codekb-publish
//
// A project folder named with a space or another character outside letters,
// digits, ".", "_" and "-" ("portal app", an accented name, "R&D", ".hidden")
// still gets its code knowledge base: the engine makes the name it derives
// from the folder that shape itself, the same way every time, and the folder
// keeps its name. A name typed as --repo is taken as typed and checked by the
// repo-name rule. The accent case runs in both Unicode
// spellings, because a name on macOS can come back decomposed (NFD) where
// Windows and Linux usually keep it composed (NFC).

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SPACE, REPO_ROOT, resetAidlcEnv, seedWorkspaceShell, toPortablePath } from "../harness/fixtures.ts";
import {
  codekbRepoName,
  codekbScopeFingerprint,
  folderRepoName,
  sourceCheckoutLabelFor,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

resetAidlcEnv();

const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const ARTIFACT_NAMES = [
  "api-documentation.md",
  "architecture.md",
  "business-overview.md",
  "code-quality-assessment.md",
  "code-structure.md",
  "component-inventory.md",
  "dependencies.md",
  "reverse-engineering-timestamp.md",
  "technology-stack.md",
];
const CAFE_NFC = "caf\u00e9";
const CAFE_NFD = "cafe\u0301";

const parents: string[] = [];
afterAll(() => {
  for (const dir of parents) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// A git project in a folder with exactly this name, no repos registered: the
// folder is the repo, as on a person's machine.
function projectNamed(name: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-folder-name-")));
  parents.push(parent);
  const project = join(parent, name);
  mkdirSync(join(project, "src"), { recursive: true });
  seedWorkspaceShell(project);
  writeFileSync(join(project, "src", "app.js"), "export const greet = () => \"hello\";\n");
  git(project, "init", "-q");
  git(project, "add", "src");
  git(project, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  return toPortablePath(project);
}

function utility(project: string, args: string[]) {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return spawnSync(process.execPath, [UTILITY, ...args, "--project-dir", project], {
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

describe("a repo name the engine derives from a folder fits the repo-name rule", () => {
  test("a name that already fits comes back byte for byte", () => {
    for (const name of ["portal-app", "My.App_1", "a..b", "x."]) expect(folderRepoName(name)).toBe(name);
  });

  test("spaces and other characters become one hyphen, a leading dot and a trailing hyphen go", () => {
    expect(folderRepoName("portal app")).toBe("portal-app");
    expect(folderRepoName("R&D")).toBe("R-D");
    expect(folderRepoName(".hidden")).toBe("hidden");
    expect(folderRepoName("app (copy)")).toBe("app-copy");
    expect(folderRepoName("Zurich  Team ")).toBe("Zurich-Team");
  });

  test("an accent is dropped the same way in both Unicode spellings (macOS NFD, Windows and Linux NFC)", () => {
    expect(folderRepoName(CAFE_NFC)).toBe("cafe");
    expect(folderRepoName(CAFE_NFD)).toBe("cafe");
  });

  test("a name with no letter or digit left is empty, for the caller's own fallback", () => {
    expect(folderRepoName("\u65e5\u672c")).toBe("");
    expect(folderRepoName("&&")).toBe("");
  });
});

describe("Reverse Engineering's tools in a project folder named with a space or another character", () => {
  for (const [folder, repo] of [
    ["portal app", "portal-app"],
    [CAFE_NFC, "cafe"],
    [CAFE_NFD, "cafe"],
    ["R&D", "R-D"],
    [".hidden", "hidden"],
  ] as const) {
    test(`${JSON.stringify(folder)}: codekb-path names ${repo} and the snapshot runs, with and without that name`, () => {
      const project = projectNamed(folder);
      expect(codekbRepoName(project)).toBe(repo);
      const path = utility(project, ["codekb-path", "--json"]);
      expect(path.status, path.stderr).toBe(0);
      expect(JSON.parse(path.stdout)).toEqual({
        space: DEFAULT_SPACE,
        repo,
        dir: `aidlc/spaces/${DEFAULT_SPACE}/codekb/${repo}`,
      });
      for (const args of [[], ["--repo", repo]]) {
        const snapshot = utility(project, ["codekb-snapshot", ...args, "--paths", "./", "--json"]);
        expect(snapshot.status, snapshot.stdout + snapshot.stderr).toBe(0);
        expect(JSON.parse(snapshot.stdout).store).toBe(`aidlc/spaces/${DEFAULT_SPACE}/codekb/${repo}/`);
      }
      expect(existsSync(project)).toBe(true);
    });
  }

  test("a scan of \"portal app\" publishes its store under portal-app, and the folder keeps its name", () => {
    const project = projectNamed("portal app");
    const paths = ["src/"];
    const snapshot = utility(project, ["codekb-snapshot", "--paths", paths.join(","), "--json"]);
    expect(snapshot.status, snapshot.stdout + snapshot.stderr).toBe(0);
    const baseline = JSON.parse(snapshot.stdout);
    const candidate = join(project, "candidate");
    mkdirSync(candidate);
    const fingerprint = codekbScopeFingerprint(project, paths);
    expect(fingerprint).not.toBeNull();
    for (const name of ARTIFACT_NAMES) {
      writeFileSync(
        join(candidate, name),
        name === "reverse-engineering-timestamp.md"
          ? [
            "# Reverse Engineering Timestamp",
            "",
            "## Scope of Analysis",
            "",
            "```yaml",
            "scope_version: 1",
            "kind: partial",
            "intent: greeter",
            `fingerprint: ${fingerprint}`,
            "analyzed:",
            "  paths:",
            "    - src/",
            "  components:",
            "    - greeter",
            "shallow:",
            "  paths:",
            "```",
            "",
          ].join("\n")
          : `# ${name}\n\nGREETER\n`,
      );
    }
    const published = utility(project, [
      "codekb-publish",
      "--staged",
      candidate,
      "--paths",
      paths.join(","),
      "--expect-store",
      baseline.store_generation,
      "--expect-source",
      baseline.source_fingerprint,
      "--json",
    ]);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    const store = join(project, "aidlc", "spaces", DEFAULT_SPACE, "codekb");
    expect(readdirSync(store)).toEqual(["portal-app"]);
    expect(readdirSync(join(store, "portal-app")).sort()).toEqual(ARTIFACT_NAMES);
    expect(existsSync(project)).toBe(true);
  });

  test("a --repo is taken as typed, and refused only for a name the repo-name rule refuses", () => {
    const project = projectNamed("portal app");
    const path = utility(project, ["codekb-path", "--repo", "portal app", "--json"]);
    expect(path.status, path.stdout + path.stderr).toBe(0);
    expect(JSON.parse(path.stdout).dir).toBe(`aidlc/spaces/${DEFAULT_SPACE}/codekb/portal app`);
    const typed = utility(project, ["codekb-snapshot", "--repo", "a/b", "--paths", "./", "--json"]);
    expect(typed.status).toBe(1);
    expect(typed.stdout + typed.stderr).toContain("Invalid --repo \\\"a/b\\\"");
  });

  test("a folder name with no letter or digit left keeps one store, named project", () => {
    const project = projectNamed("\u65e5\u672c");
    expect(codekbRepoName(project)).toBe("project");
    const snapshot = utility(project, ["codekb-snapshot", "--paths", "./", "--json"]);
    expect(snapshot.status, snapshot.stdout + snapshot.stderr).toBe(0);
    expect(JSON.parse(snapshot.stdout).repo).toBe("project");
  });

  test("a linked git worktree of a checkout in \"portal app\" names the store after that checkout", () => {
    const main = projectNamed("portal app");
    const worktree = join(main, "..", "portal app fix");
    git(main, "worktree", "add", "-q", "-b", "fix", worktree);
    seedWorkspaceShell(worktree);
    expect(codekbRepoName(toPortablePath(realpathSync(worktree)))).toBe("portal-app");
  });
});

describe("a recorded checkout's label follows the same rule", () => {
  test("its folder name fits the rule as the store name does, numbered when taken", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-folder-name-")));
    parents.push(parent);
    const at = (name: string) => join(parent, name);
    expect(sourceCheckoutLabelFor(at("feature"), [])).toBe("feature");
    expect(sourceCheckoutLabelFor(at("my feature"), [])).toBe("my-feature");
    expect(sourceCheckoutLabelFor(at(CAFE_NFD), [])).toBe("cafe");
    expect(sourceCheckoutLabelFor(at("\u65e5\u672c"), [])).toBe("checkout");
    expect(sourceCheckoutLabelFor(at("my feature"), [{ label: "my-feature", path: "x", real: at("x") }])).toBe("my-feature-2");
  });
});
