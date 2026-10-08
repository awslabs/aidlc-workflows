// covers: function:workspaceSourceState
//
// The source walk lists a directory, examines each entry, then reads each
// file. A build or an indexer running at the same time can remove a file in
// either window (an editor's temporary file goes between the listing and the
// stat; a lock file goes between the stat and the read), or rewrite it while
// it is being read; each used to fail the whole bind as "unreadable" (#2113:
// a code indexer's lock file), so Plan Approval could not be shown for a
// change nobody made. Now a file gone when the walk reaches it, in either
// window, is left out, as the next walk would leave it, and a file whose size
// or timestamps move during the read is read again a few times before it
// counts as unreadable. The walk is synchronous, so test hooks set in this
// process stand in for the other process (_setSourceWalkTestHooksForTests);
// nothing in the environment drives them. Permission denied still fails closed
// (t401).

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _setSourceWalkTestHooksForTests,
  lastWorkspaceSourceFailure,
  workspaceSourceState,
} from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const ENV_NAMES = ["AIDLC_TEST_SOURCE_VANISH_BEFORE_READ", "AIDLC_TEST_SOURCE_UNSTABLE_READS"];
const created: string[] = [];
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
afterEach(() => {
  _setSourceWalkTestHooksForTests(null);
  while (created.length) cleanupTestProject(created.pop());
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.dart"), "void main() {}\n");
  return project;
}

function fingerprint(project: string): string {
  const state = workspaceSourceState(project);
  expect(state, `the source boundary did not bind: ${JSON.stringify(lastWorkspaceSourceFailure())}`).not.toBeNull();
  return state!.fingerprint;
}

describe("t-source-walk-vanished-file: a file that disappears or moves during the source walk", () => {
  test("a file gone when the walk reads it is left out, and the boundary binds as without it", () => {
    const project = sourceProject();
    const without = fingerprint(project);
    const partial = join(project, "src", "partial.dart");
    writeFileSync(partial, "// being written\n");
    _setSourceWalkTestHooksForTests({ vanishBeforeRead: "src/partial.dart" });
    expect(fingerprint(project)).toBe(without);
    expect(existsSync(partial)).toBe(false);
  });

  test("a file gone before its entry is examined (listed, then removed while earlier entries were walked) is left out too", () => {
    const project = sourceProject();
    const without = fingerprint(project);
    const temp = join(project, "src", ".main.dart.swp");
    writeFileSync(temp, "editor state\n");
    _setSourceWalkTestHooksForTests({ vanishBeforeStat: "src/.main.dart.swp" });
    expect(fingerprint(project)).toBe(without);
    expect(existsSync(temp)).toBe(false);
  });

  test("a file rewritten during the read is read again and binds with its final bytes", () => {
    const project = sourceProject();
    const flaky = join(project, "src", "flaky.dart");
    writeFileSync(flaky, "int flaky() => 1;\n");
    _setSourceWalkTestHooksForTests({ unstableReads: { path: "src/flaky.dart", count: 2 } });
    const bound = fingerprint(project);
    // The other process wrote twice while the walk read; the walk saw it both times.
    expect(readFileSync(flaky, "utf-8")).toBe("int flaky() => 1;\nxx");
    _setSourceWalkTestHooksForTests(null);
    expect(fingerprint(project)).toBe(bound);
  });

  test("a file that never settles still fails closed as unreadable, naming the path", () => {
    const project = sourceProject();
    writeFileSync(join(project, "src", "flaky.dart"), "int flaky() => 1;\n");
    _setSourceWalkTestHooksForTests({ unstableReads: { path: "src/flaky.dart", count: 10 } });
    expect(workspaceSourceState(project)).toBeNull();
    expect(lastWorkspaceSourceFailure()).toMatchObject({ code: "unreadable", path: "src/flaky.dart" });
  });

  test.skipIf(isRoot)("a file the walk may not read still fails closed as unreadable", () => {
    const project = sourceProject();
    const locked = join(project, "src", "locked.dart");
    writeFileSync(locked, "int locked() => 1;\n");
    chmodSync(locked, 0o000);
    try {
      expect(workspaceSourceState(project)).toBeNull();
      expect(lastWorkspaceSourceFailure()).toMatchObject({ code: "unreadable", path: "src/locked.dart" });
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  test("the environment does not drive the hooks: a project's files are never touched by a walk", () => {
    const project = sourceProject();
    const main = join(project, "src", "main.dart");
    const before = fingerprint(project);
    process.env.AIDLC_TEST_SOURCE_VANISH_BEFORE_READ = "src/main.dart";
    process.env.AIDLC_TEST_SOURCE_UNSTABLE_READS = "src/main.dart:2";
    expect(fingerprint(project)).toBe(before);
    expect(readFileSync(main, "utf-8")).toBe("void main() {}\n");
  });
});
