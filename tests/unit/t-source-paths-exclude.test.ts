// covers: function:workspaceSourceState, function:shapeSourceSnapshotIndex
//
// The source walk knew only the directory names the engine ships (node_modules,
// the conditional build/ and dist/, the folders a package manager fills beside
// its manifest). A machine-local tree with any other name (#2113: a code
// indexer's cache, an in-tree build output) ran the walk past its budget or
// made a file unreadable, the boundary came back unbindable, Plan Approval
// could not be shown, and the remedy text named a step that did not exist for
// such a tree: deleting it (the next build recreates it) or the human-only
// break-glass phrase. `.aidlc-source-paths.json` now takes an `exclude` list
// beside `paths`: the path and everything under it leave the boundary, the
// swarm Source Commit keeps HEAD's copy of it, and a registered path beneath it
// still wins. These tests pin the shape, the precedence, the refusals for a
// malformed entry, and the snapshot.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  lastWorkspaceSourceFailure,
  shapeSourceSnapshotIndex,
  workspaceSourceState,
} from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const ENTRIES_BUDGET = "AIDLC_TEST_SOURCE_MAX_ENTRIES";
const created: string[] = [];
const scratch: string[] = [];
const savedBudget = process.env[ENTRIES_BUDGET];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  if (savedBudget === undefined) delete process.env[ENTRIES_BUDGET];
  else process.env[ENTRIES_BUDGET] = savedBudget;
});

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.dart"), "void main() {}\n");
  return project;
}

function registry(project: string, body: Record<string, unknown>): void {
  writeFileSync(join(project, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, ...body }));
}

function fingerprint(project: string): string {
  const state = workspaceSourceState(project);
  expect(state, `the source boundary did not bind: ${JSON.stringify(lastWorkspaceSourceFailure())}`).not.toBeNull();
  return state!.fingerprint;
}

/** What a code indexer or build leaves behind under `dir`: many small files. */
function fillCache(dir: string, count: number, stamp: string): void {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index++) {
    writeFileSync(join(dir, `object-${index}.bin`), `\u0000${stamp} ${index}\n`);
  }
}

describe("t-source-paths-exclude: the exclude list in .aidlc-source-paths.json", () => {
  test("an excluded directory is outside the boundary: past the budget it still binds, and churn under it never moves the fingerprint", () => {
    const project = sourceProject();
    registry(project, { paths: [], exclude: ["tools/.indexer"] });
    const before = fingerprint(project);
    fillCache(join(project, "tools", ".indexer"), 60, "v1");
    // Low enough that walking the excluded tree would exceed it, high enough for
    // the project's own entries.
    process.env[ENTRIES_BUDGET] = "40";
    expect(fingerprint(project)).toBe(before);
    fillCache(join(project, "tools", ".indexer"), 60, "v2");
    expect(fingerprint(project)).toBe(before);
    // The project's own source still counts.
    writeFileSync(join(project, "src", "main.dart"), "void main() { print('hi'); }\n");
    expect(fingerprint(project)).not.toBe(before);
  });

  test("an excluded file is outside the boundary, and `paths` may be left out", () => {
    const project = sourceProject();
    registry(project, { exclude: ["src/generated.g.dart"] });
    const before = fingerprint(project);
    writeFileSync(join(project, "src", "generated.g.dart"), "// generated v1\n");
    expect(fingerprint(project)).toBe(before);
    writeFileSync(join(project, "src", "generated.g.dart"), "// generated v2\n");
    expect(fingerprint(project)).toBe(before);
  });

  test("a registered path under an excluded directory wins, and its siblings stay out", () => {
    const project = sourceProject();
    registry(project, { paths: ["vendor/ours/src"], exclude: ["vendor"] });
    fillCache(join(project, "vendor", "theirs"), 5, "v1");
    mkdirSync(join(project, "vendor", "ours", "src"), { recursive: true });
    writeFileSync(join(project, "vendor", "ours", "src", "lib.dart"), "int ours() => 1;\n");
    const before = fingerprint(project);
    writeFileSync(join(project, "vendor", "ours", "src", "lib.dart"), "int ours() => 2;\n");
    const edited = fingerprint(project);
    expect(edited).not.toBe(before);
    fillCache(join(project, "vendor", "theirs"), 5, "v2");
    expect(fingerprint(project)).toBe(edited);
  });

  test.each(["../outside", "/abs/path", ".", "a/../b"])("a malformed exclude %p is refused and named", (entry) => {
    const project = sourceProject();
    registry(project, { exclude: [entry] });
    expect(workspaceSourceState(project)).toBeNull();
    const failure = lastWorkspaceSourceFailure();
    expect(failure?.code).toBe("registered-sources-invalid");
    expect(failure?.detail).toContain(JSON.stringify(entry));
  });

  test("the swarm snapshot keeps HEAD's copy of an excluded tracked tree and takes the edit to a registered path under it", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-source-paths-exclude-"));
    scratch.push(dir);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: env ?? process.env });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const write = (files: ReadonlyArray<readonly [string, string]>) => {
      for (const [path, content] of files) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    write([
      ["src/main.dart", "void main() {}\n"],
      ["generated/schema.dart", "// schema v1\n"],
      ["generated/ours/hand.dart", "int hand() => 1;\n"],
      [".aidlc-source-paths.json", JSON.stringify({ version: 1, paths: ["generated/ours"], exclude: ["generated"] })],
    ]);
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const committedSchema = git(["rev-parse", "HEAD:generated/schema.dart"]).trim();
    write([
      ["generated/schema.dart", "// schema v2, regenerated\n"],
      ["generated/ours/hand.dart", "int hand() => 2;\n"],
      ["src/main.dart", "void main() { print('hi'); }\n"],
    ]);
    const indexFile = join(tmpdir(), `t-source-paths-exclude-index-${process.pid}-${Date.now()}`);
    scratch.push(indexFile);
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    git(["add", "-A"], env);
    expect(shapeSourceSnapshotIndex(dir, indexFile, false)).not.toBeNull();
    const staged = new Map(
      git(["ls-files", "-s"], env)
        .trim()
        .split("\n")
        .map((line) => [line.slice(line.indexOf("\t") + 1), line.split(" ")[1]]),
    );
    expect(staged.get("generated/schema.dart")).toBe(committedSchema);
    for (const edited of ["generated/ours/hand.dart", "src/main.dart"]) {
      expect(staged.get(edited)).toBe(git(["hash-object", edited]).trim());
    }
  });
});
