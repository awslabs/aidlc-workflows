// covers: function:workspaceSourceState
//
// The source walk lists a directory, then reads each file. A build or an
// indexer running at the same time can remove a file between those two steps,
// or rewrite it while it is being read; either used to fail the whole bind as
// "unreadable" (#2113: a code indexer's lock file), so Plan Approval could not
// be shown for a change nobody made. Now a file gone when the walk reaches it
// is left out, as the next walk would leave it, and a file whose size or
// timestamps move during the read is read again a few times before it counts
// as unreadable. The walk is synchronous, so two test seams stand in for the
// other process: AIDLC_TEST_SOURCE_VANISH_BEFORE_READ removes the named file
// right before its read, AIDLC_TEST_SOURCE_UNSTABLE_READS=<path>:<n> grows it
// during the first n reads. Permission denied still fails closed (t401).

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastWorkspaceSourceFailure, workspaceSourceState } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const VANISH = "AIDLC_TEST_SOURCE_VANISH_BEFORE_READ";
const UNSTABLE = "AIDLC_TEST_SOURCE_UNSTABLE_READS";
const created: string[] = [];
const saved: Record<string, string | undefined> = { [VANISH]: process.env[VANISH], [UNSTABLE]: process.env[UNSTABLE] };
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
  for (const name of [VANISH, UNSTABLE]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
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
  test("a file gone when the walk reaches it is left out, and the boundary binds as without it", () => {
    const project = sourceProject();
    const without = fingerprint(project);
    const partial = join(project, "src", "partial.dart");
    writeFileSync(partial, "// being written\n");
    process.env[VANISH] = "src/partial.dart";
    expect(fingerprint(project)).toBe(without);
    expect(existsSync(partial)).toBe(false);
  });

  test("a file rewritten during the read is read again and binds with its final bytes", () => {
    const project = sourceProject();
    const flaky = join(project, "src", "flaky.dart");
    writeFileSync(flaky, "int flaky() => 1;\n");
    process.env[UNSTABLE] = "src/flaky.dart:2";
    const bound = fingerprint(project);
    // The other process wrote twice while the walk read; the walk saw it both times.
    expect(readFileSync(flaky, "utf-8")).toBe("int flaky() => 1;\nxx");
    delete process.env[UNSTABLE];
    expect(fingerprint(project)).toBe(bound);
  });

  test("a file that never settles still fails closed as unreadable, naming the path", () => {
    const project = sourceProject();
    writeFileSync(join(project, "src", "flaky.dart"), "int flaky() => 1;\n");
    process.env[UNSTABLE] = "src/flaky.dart:10";
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
});
