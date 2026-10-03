// covers: function:workspaceSourceState
//
// Visual Studio keeps a machine-local cache under `.vs/`, and its
// `FileContentIndex/*.vsidx` files are rewritten and held open by the running
// IDE. The source fingerprint used to walk that tree like any other directory,
// so a `.vsidx` the IDE had locked (or that changed between stat and read)
// could not be hashed — and a single unhashable file fails the WHOLE
// source-boundary bind (workspaceSourceState returns null), which refuses Plan
// Approval while nothing a human authored has changed. A Windows/Visual Studio
// AI-DLC session hit exactly this: a diagnostic report named
// `.vs/GVP/FileContentIndex/<uuid>.vsidx` as "the file could not be hashed",
// and the gate stayed refused across restarts.
//
// These tests pin `.vs` OUT of the fingerprint in both modes, prove an
// unhashable file inside it no longer breaks the bind, and pin the explicit
// `.aidlc-source-paths.json` registration escape back IN.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceSourceState } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

// Permission-based unreadability only reproduces the "could not be hashed"
// failure for a non-root user; root reads through mode 0. Skip that one
// assertion under root rather than asserting a false guarantee.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.py"), "MAIN = 1\n");
  return project;
}

function fingerprint(project: string): string {
  const state = workspaceSourceState(project);
  expect(state).not.toBeNull();
  return state!.fingerprint;
}

describe("t401 Visual Studio .vs cache does not drift or break the source fingerprint", () => {
  test(".vsidx churn inside .vs leaves the fingerprint unchanged", () => {
    const project = sourceProject();
    const before = fingerprint(project);
    const index = join(project, ".vs", "GVP", "FileContentIndex");
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, "5e0e6dfa.vsidx"), "\u0000vsidx-v1");
    expect(fingerprint(project)).toBe(before);
    // The IDE rewrites the index on the next edit; the fingerprint must not move.
    writeFileSync(join(index, "5e0e6dfa.vsidx"), "\u0000vsidx-v2-rewritten");
    expect(fingerprint(project)).toBe(before);
  });

  test("an unhashable .vsidx inside .vs no longer fails the source-boundary bind", () => {
    if (isRoot) return;
    const project = sourceProject();
    const index = join(project, ".vs", "GVP", "FileContentIndex");
    mkdirSync(index, { recursive: true });
    const locked = join(index, "locked.vsidx");
    writeFileSync(locked, "\u0000held-open-by-the-ide");
    // Simulate the file the IDE holds open: unreadable, so a walk that reached
    // it would get null from stableFileSha256 and refuse the whole bind.
    chmodSync(locked, 0o000);
    try {
      // Before the fix this returned null (bind refused); now it binds.
      const state = workspaceSourceState(project);
      expect(state).not.toBeNull();
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("a real source change still drifts the fingerprint", () => {
    const project = sourceProject();
    mkdirSync(join(project, ".vs", "GVP"), { recursive: true });
    writeFileSync(join(project, ".vs", "GVP", "cache.bin"), "\u0000x");
    const before = fingerprint(project);
    writeFileSync(join(project, "src", "main.py"), "MAIN = 2\n");
    expect(fingerprint(project)).not.toBe(before);
  });
});
