// covers: function:worktreePath, function:boltName, function:parseBoltName
//
// The path helpers compose strings without I/O or create-time slug validation.
// Parsing must distinguish the disjoint namespaced and pre-upgrade shapes.

import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { boltName, parseBoltName, worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const PROJ = "/tmp/proj";
const ID8 = "abcdef01";


describe("worktreePath() (in-process, pure string composer)", () => {
  test("namespaces the leaf while preserving the absolute project root", () => {
    const path = worktreePath(PROJ, ID8, "demo");
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(PROJ, ".aidlc", "worktrees", boltName(ID8, "demo")));
    expect(worktreePath(PROJ, "12345678", "demo")).not.toBe(path);
  });

  test("does not validate or sanitise a slug containing '/'", () => {
    expect(worktreePath(PROJ, ID8, "a/b"))
      .toBe(join(PROJ, ".aidlc", "worktrees", boltName(ID8, "a"), "b"));
  });
});

describe("Bolt names distinguish intent namespaces from legacy slugs", () => {
  test("namespaced names round-trip the intent and human slug", () => {
    expect(boltName(ID8, "api")).toBe("bolt-abcdef01_api");
    expect(parseBoltName(boltName(ID8, "api")))
      .toEqual({ intentId8: ID8, slug: "api" });
  });

  test("a hex-looking prefix separated by a hyphen remains a legacy slug", () => {
    // Deliberate pre-upgrade spelling: '-' cannot introduce an intent namespace.
    expect(parseBoltName("bolt-abcdef01-api"))
      .toEqual({ intentId8: null, slug: "abcdef01-api" });
  });

  test.each([
    "bolt-ABCDEF01_api",
    "bolt-abcdef0_api",
    "bolt-abcdef012_api",
    "bolt-abcdef01_",
    "bolt-abcdef01_1api",
    "bolt-abcdef01_api_v2",
    "bolt-abcdef01_api/other",
    "other-abcdef01_api",
  ])("rejects malformed Bolt name %s", (name) => {
    expect(parseBoltName(name)).toBeNull();
  });
});
