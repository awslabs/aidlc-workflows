// covers: function:codekbRepoName, function:isValidRepoName, function:repoNameRefusal, subcommand:aidlc-utility:codekb-path, subcommand:aidlc-utility:codekb-snapshot, subcommand:aidlc-utility:codekb-scope-diff, subcommand:aidlc-utility:codekb-publish

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SPACE,
  REPO_ROOT,
  resetAidlcEnv,
  seededStateFile,
  seedWorkspaceShell,
  toPortablePath,
} from "../harness/fixtures.ts";
import { codekbScopeFingerprint, isValidRepoName, repoNameProblem, repoNameRefusal } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

resetAidlcEnv();

const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const FOLDER = "My Example App";
const STORE = `aidlc/spaces/${DEFAULT_SPACE}/codekb/${FOLDER}`;
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

function projectNamed(name: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-codekb-repo-name-")));
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

function ran(project: string, args: string[]): Record<string, unknown> {
  const result = utility(project, args);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("a project folder named with a space is one repo with one CodeKB store", () => {
  test("codekb-path prints the folder's own name as the store directory", () => {
    const project = projectNamed(FOLDER);
    expect(ran(project, ["codekb-path", "--json"]).dir).toBe(STORE);
  });

  test("codekb-snapshot names that store without --repo, with the folder's spelling, and with the coining release's", () => {
    const project = projectNamed(FOLDER);
    for (const args of [[], ["--repo", FOLDER], ["--repo", "My-Example-App"]]) {
      const snapshot = ran(project, ["codekb-snapshot", ...args, "--paths", "./", "--json"]);
      expect(snapshot.repo, args.join(" ")).toBe(FOLDER);
      expect(snapshot.store, args.join(" ")).toBe(`${STORE}/`);
    }
  });

  test("a scan publishes under that name, and both spellings then see the store as CURRENT", () => {
    const project = projectNamed(FOLDER);
    const paths = ["src/"];
    const baseline = ran(project, ["codekb-snapshot", "--paths", paths.join(","), "--json"]);
    const fingerprint = codekbScopeFingerprint(project, paths);
    expect(fingerprint).not.toBeNull();
    const candidate = join(project, "candidate");
    mkdirSync(candidate);
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
    ran(project, [
      "codekb-publish",
      "--staged",
      candidate,
      "--paths",
      paths.join(","),
      "--expect-store",
      String(baseline.store_generation),
      "--expect-source",
      String(baseline.source_fingerprint),
      "--json",
    ]);
    const root = join(project, "aidlc", "spaces", DEFAULT_SPACE, "codekb");
    expect(readdirSync(root)).toEqual([FOLDER]);
    expect(readdirSync(join(root, FOLDER)).sort()).toEqual(ARTIFACT_NAMES);
    for (const args of [[], ["--repo", FOLDER], ["--repo", "My-Example-App"]]) {
      expect(ran(project, ["codekb-scope-diff", ...args, "--json"]).verdict, args.join(" ")).toBe("CURRENT");
    }
    expect(existsSync(project)).toBe(true);
    expect(readdirSync(join(project, ".."))).toContain(FOLDER);
  });

  test("a name that is not this folder's is still taken as typed", () => {
    const project = projectNamed(FOLDER);
    expect(ran(project, ["codekb-path", "--repo", "other-repo", "--json"]).dir)
      .toBe(`aidlc/spaces/${DEFAULT_SPACE}/codekb/other-repo`);
  });

  test("a store an earlier release named My-Example-App is adopted, not orphaned by a second store", () => {
    const project = projectNamed(FOLDER);
    writeFileSync(seededStateFile(project), "# AI-DLC State\n\n## Stage Progress\n");
    const coined = join(project, "aidlc", "spaces", DEFAULT_SPACE, "codekb", "My-Example-App");
    mkdirSync(coined, { recursive: true });
    writeFileSync(join(coined, "business-overview.md"), "# Business Overview\n\nGREETER\n");
    for (const args of [[], ["--repo", FOLDER], ["--repo", "My-Example-App"]]) {
      const path = ran(project, ["codekb-path", ...args, "--json"]);
      expect(path.repo, args.join(" ")).toBe("My-Example-App");
      expect(path.dir, args.join(" ")).toBe(`aidlc/spaces/${DEFAULT_SPACE}/codekb/My-Example-App`);
    }
    expect(readdirSync(join(project, "aidlc", "spaces", DEFAULT_SPACE, "codekb"))).toEqual(["My-Example-App"]);
  });
});

describe("a name that is not one folder's name is still refused, with the reason", () => {
  test("the rule refuses separators, traversal, and the empty name", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(isValidRepoName(bad), JSON.stringify(bad)).toBe(false);
      expect(repoNameProblem(bad), JSON.stringify(bad)).toBe(
        'is not one folder\'s name (no "/" or "\\", not "." or "..")',
      );
    }
    for (const good of [FOLDER, "portal app", "portal-app", "My.App_1"]) {
      expect(isValidRepoName(good), good).toBe(true);
    }
  });

  test("every codekb verb refuses one with the exact text, and reads nothing outside the store", () => {
    const project = projectNamed(FOLDER);
    for (const bad of [".", "..", "a/b", "a\\b"]) {
      for (const args of [
        ["codekb-path"],
        ["codekb-snapshot", "--paths", "./"],
        ["codekb-scope-diff"],
        ["codekb-publish", "--staged", "candidate"],
      ]) {
        const result = utility(project, [...args, "--repo", bad, "--json"]);
        expect(result.status, `${args[0]} --repo ${bad}`).toBe(1);
        const line = `${result.stdout}${result.stderr}`.split("\n").find((entry) => entry.startsWith("{\"error\":"));
        expect(line, `${args[0]} --repo ${bad}`).toBeDefined();
        expect(JSON.parse(String(line)).error, `${args[0]} --repo ${bad}`).toBe(repoNameRefusal("Invalid --repo", bad));
      }
    }
  });
});
