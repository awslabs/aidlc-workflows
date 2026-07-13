// covers: tool:aidlc-sensor-linter
//
// t237 - the linter sensor's eslint invocations are version-pinned.
//
// A BARE `bunx eslint` prefers a project-local node_modules eslint, then
// ANY `eslint` on PATH, before fetching from the registry. Distro
// packages ship ancient versions (Ubuntu 24.04's apt eslint is 6.4.0, a
// transitive dependency of `apt install npm`); pre-flat-config eslint
// cannot see eslint.config.js, reports "couldn't find a configuration
// file", and the sensor silently degrades every fire to a
// tool-unavailable PASS - masking real lint findings (observed on a real
// box 2026-07-13: t92 tests 11/15 red purely from the apt package).
//
// The guard: every bunx invocation in the shipped linter sensor script
// must pass the pinned ESLINT_SPEC, never the bare string "eslint".
// Source-pin over behavior: exercising the PATH-shadow scenario live
// needs a writable PATH dir + registry access and is racy under -P;
// the invariant is fully visible in the source.
//
// All four dist projections carry the same byte-identical script (the
// packager copies core/tools verbatim; t145-packaging-parity guards
// cross-dist parity), so asserting on dist/claude covers the rest.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-sensor-linter.ts",
);

describe("t237 linter sensor eslint version pin", () => {
  const src = readFileSync(SHIPPED, "utf-8");

  test("declares a pinned ESLINT_SPEC with an explicit major", () => {
    expect(src).toMatch(/const ESLINT_SPEC = "eslint@\d+"/);
  });

  test("no spawnSync bunx invocation passes bare 'eslint' as the tool arg", () => {
    // Every `spawnSync("bunx", [<first-arg>, ...])` in the script must use
    // ESLINT_SPEC. A literal "eslint" first element would resolve through
    // node_modules/PATH and reintroduce the shadowing bug.
    const bunxFirstArgs = [...src.matchAll(/spawnSync\(\s*"bunx",\s*\[\s*("(?:[^"]*)"|[A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    expect(bunxFirstArgs.length).toBeGreaterThan(0);
    for (const arg of bunxFirstArgs) {
      expect(arg).toBe("ESLINT_SPEC");
    }
  });
});
