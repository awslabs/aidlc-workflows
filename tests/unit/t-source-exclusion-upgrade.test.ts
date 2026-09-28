// covers: function:sameWorkspaceSource, function:recordedSourceListingUnderCurrentBoundary, function:sourceRawDiffNameExcludedPaths
//
// Files the source walk now leaves out by name (.DS_Store, coverage databases,
// __pycache__) were part of the fingerprint before. Evidence recorded then must
// still compare equal when nothing changed, or upgrading mid-workflow stops a
// stage on a file nobody touched. These pin the three pieces that make that
// hold: the earlier walk's value kept beside today's, recorded listings read
// under today's exclusions, and the snapshot/finalize filter over git's raw diff.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordedSourceListingUnderCurrentBoundary,
  sameWorkspaceSource,
  sourceRawDiffNameExcludedPaths,
  workspaceSourceState,
} from "../../core/tools/aidlc-lib.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// The walk's own formula, written out: file lines in sorted walk order, then
// the filesystem digest wrapped in the workspace digest.
function referenceFingerprint(files: Array<[string, string]>): string {
  const lines = files.map(([rel, body]) => `file:${rel}:-=${sha256(body)}`);
  const filesystem = sha256(["aidlc-filesystem-source-v2", ...lines].join("\n"));
  return sha256(["aidlc-workspace-source-v2", `filesystem=${filesystem}`].join("\n"));
}

function bareProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-source-exclusion-upgrade-"));
  created.push(dir);
  return dir;
}

describe("t-source-exclusion-upgrade", () => {
  test("the walk keeps the earlier value beside its own, and only an unchanged workspace matches it", () => {
    const dir = bareProject();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "__pycache__"));
    const files: Array<[string, string]> = [
      [".coverage", "SQLite format 3\u0000v1"],
      ["__pycache__/m.cpython-312.pyc", "compiled"],
      ["src/.DS_Store", "\u0000\u0000finder"],
      ["src/main.ts", "export const main = 1;\n"],
    ];
    for (const [rel, body] of files) writeFileSync(join(dir, rel), body);

    const state = workspaceSourceState(dir);
    expect(state).not.toBeNull();
    // Today's walk binds only the real source.
    expect(state!.fingerprint).toBe(referenceFingerprint([["src/main.ts", "export const main = 1;\n"]]));
    // Evidence the earlier walk recorded (every file) still describes this source.
    const earlier = referenceFingerprint(files);
    expect(earlier).not.toBe(state!.fingerprint);
    expect(sameWorkspaceSource(earlier, state!.fingerprint)).toBe(true);
    expect(sameWorkspaceSource(`${"0".repeat(64)}`, state!.fingerprint)).toBe(false);

    // A later rewrite of an excluded file leaves today's value alone; under the
    // earlier rules it was a change, so that earlier evidence no longer matches.
    writeFileSync(join(dir, "src/.DS_Store"), "\u0000\u0000finder moved an icon");
    const after = workspaceSourceState(dir);
    expect(after!.fingerprint).toBe(state!.fingerprint);
    expect(sameWorkspaceSource(earlier, after!.fingerprint)).toBe(false);

    // A real source change moves today's value.
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    expect(workspaceSourceState(dir)!.fingerprint).not.toBe(state!.fingerprint);
  });

  test("a workspace with nothing excluded by name keeps no earlier value", () => {
    const dir = bareProject();
    writeFileSync(join(dir, "main.ts"), "export const main = 1;\n");
    const state = workspaceSourceState(dir);
    expect(sameWorkspaceSource(referenceFingerprint([["main.ts", "export const main = 1;\n"]]), state!.fingerprint)).toBe(true);
    expect(sameWorkspaceSource(`${"1".repeat(64)}`, state!.fingerprint)).toBe(false);
  });

  test("a recorded listing is read under today's exclusions, type-aware", () => {
    const file = (n: string) => `100644 ${n.repeat(64)}`;
    const recorded = new Map<string, string>([
      ["\u0000src/main.ts", file("a")],
      ["\u0000src/.DS_Store", file("b")],
      ["\u0000.coverage", file("c")],
      ["\u0000pkg/__pycache__/m.pyc", file("d")],
      ["\u0000links/.DS_Store", `120000 ${"e".repeat(64)}`],
      ["\u0000registered/.DS_Store", file("f")],
    ]);
    const current = new Map<string, string>([
      ["\u0000src/main.ts", file("a")],
      // Registered, so today's walk still carries it.
      ["\u0000registered/.DS_Store", file("f")],
    ]);
    const kept = recordedSourceListingUnderCurrentBoundary(recorded, current);
    expect([...kept.keys()].sort()).toEqual([
      "\u0000links/.DS_Store",
      "\u0000registered/.DS_Store",
      "\u0000src/main.ts",
    ]);
  });

  test("the raw diff filter keeps symlinks and registered paths, drops excluded regular files", () => {
    const z = (meta: string, path: string) => `${meta}\u0000${path}\u0000`;
    const oid = "1".repeat(40);
    const none = "0".repeat(40);
    const raw =
      z(`:100644 100644 ${oid} ${oid} M`, "src/.DS_Store") +
      z(`:100644 000000 ${oid} ${none} D`, ".coverage") +
      z(`:000000 100644 ${none} ${oid} A`, "reports/.coverage.host.123") +
      z(`:000000 120000 ${none} ${oid} A`, "links/.DS_Store") +
      z(`:100644 100644 ${oid} ${oid} M`, "keep/.DS_Store") +
      z(`:100644 100644 ${oid} ${oid} M`, "src/main.ts");
    expect(sourceRawDiffNameExcludedPaths(raw, ["keep"]).sort()).toEqual([
      ".coverage",
      "reports/.coverage.host.123",
      "src/.DS_Store",
    ]);
  });
});
