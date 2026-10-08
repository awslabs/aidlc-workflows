// covers: function:workspaceSourceState
//
// Three more machine-local trees nobody authors as application source used to
// sit inside the source boundary (#2113): JetBrains' `.idea/`, whose
// workspace.xml is rewritten on every IDE action, so each save was "source that
// moved" after Plan Approval; a local code indexer's `.codegraph/`, whose lock
// file the daemon holds, so one file that could not be read failed the whole
// bind ("unreadable") and Plan Approval could not be shown; and Xcode's
// `DerivedData/` when a project keeps it in-tree, hundreds of megabytes of build
// output that ran the walk past its budget ("budget-bytes", "budget-entries").
// They join the hard-excluded names beside `.vs` (t401). These tests pin each
// OUT: churn in `.idea` leaves the fingerprint unchanged, an unreadable lock in
// `.codegraph` no longer fails the bind, and a `DerivedData` tree past the
// walk's entry budget no longer fails it either.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastWorkspaceSourceFailure, workspaceSourceState } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const ENTRIES_BUDGET = "AIDLC_TEST_SOURCE_MAX_ENTRIES";
const created: string[] = [];
const savedBudget = process.env[ENTRIES_BUDGET];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
  if (savedBudget === undefined) delete process.env[ENTRIES_BUDGET];
  else process.env[ENTRIES_BUDGET] = savedBudget;
});

// Permission-based unreadability only reproduces "could not be hashed" for a
// non-root user; root reads through mode 0. Skip that one case under root
// rather than asserting a false guarantee (as t401 does).
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

describe("t-machine-local-caches-outside-source-boundary: .idea, .codegraph and DerivedData are outside the source boundary", () => {
  test("JetBrains rewriting .idea/workspace.xml leaves the fingerprint unchanged", () => {
    const project = sourceProject();
    const before = fingerprint(project);
    mkdirSync(join(project, ".idea"), { recursive: true });
    writeFileSync(join(project, ".idea", "workspace.xml"), '<project version="4"><component name="ChangeListManager" rev="1"/></project>\n');
    expect(fingerprint(project)).toBe(before);
    // Every IDE action rewrites it; the fingerprint must not move.
    writeFileSync(join(project, ".idea", "workspace.xml"), '<project version="4"><component name="ChangeListManager" rev="2"/></project>\n');
    expect(fingerprint(project)).toBe(before);
    // The project's own source still counts.
    writeFileSync(join(project, "src", "main.dart"), "void main() { print('hi'); }\n");
    expect(fingerprint(project)).not.toBe(before);
  });

  test.skipIf(isRoot)("an unreadable .codegraph lock no longer fails the source-boundary bind", () => {
    const project = sourceProject();
    const before = fingerprint(project);
    mkdirSync(join(project, ".codegraph"), { recursive: true });
    const lock = join(project, ".codegraph", "codegraph.lock");
    writeFileSync(lock, "pid 4242\n");
    chmodSync(lock, 0o000);
    try {
      expect(fingerprint(project)).toBe(before);
    } finally {
      chmodSync(lock, 0o600);
    }
  });

  test("a DerivedData tree past the walk's entry budget no longer fails the bind", () => {
    const project = sourceProject();
    const before = fingerprint(project);
    const products = join(project, "DerivedData", "App-abc", "Build", "Products");
    mkdirSync(products, { recursive: true });
    for (let index = 0; index < 60; index++) {
      writeFileSync(join(products, `object-${index}.o`), `\u0000object ${index}\n`);
    }
    // Low enough that walking DerivedData would exceed it, high enough for the
    // project's own entries.
    process.env[ENTRIES_BUDGET] = "40";
    expect(fingerprint(project)).toBe(before);
  });
});
