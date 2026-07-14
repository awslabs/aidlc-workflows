// t145-packaging-parity: the dist-unified keystone drift guard.
//
// covers: file:scripts/package.ts, file:harness/claude/manifest.ts
//
// WHAT. The one-core-N-harnesses layout (dist-unified MR-1) makes dist/ a
// GENERATED artifact: `bun scripts/package.ts` projects the harness-neutral
// core/ tree + harness/<name>/ surfaces into dist/<name>/<harnessDir>/. dist/
// stays committed AND drift-guarded — `package.ts --check` rebuilds every
// harness tree into a temp dir and diffs it byte-for-byte against the committed
// dist/, exiting non-zero on any MISSING / DIFFERS / ORPHAN.
//
// This test IS that guard, run from the suite: it asserts `package.ts --check`
// exits 0, so a hand-edited dist (someone patched dist/claude/.claude directly
// instead of core/) or a forgotten regenerate (edited core/ but didn't re-run
// the packager) turns red here. It is the byte-parity keystone gate, enforced
// continuously.
//
// WHY A SUBPROCESS. package.ts is a CLI that spawns the in-tree generators
// (aidlc-graph compile, aidlc-runner-gen) per harness; running it as a child
// mirrors how a developer or CI invokes it, and isolates its temp-dir builds
// from the suite's process.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");

describe("t145 packaging parity — dist/ is in sync with core/ + harness/", () => {
  test("scripts/package.ts exists (the build entry)", () => {
    expect(existsSync(PACKAGE_TS)).toBe(true);
  });

  // CHECK_TIMEOUT_MS: `--check` builds + byte-diffs three full trees into a temp
  // dir. Standalone that is ~1.5s, but under the suite's -P8 parallelism the
  // spawned bun gets CPU-starved and can blow bun's 5s DEFAULT per-test timeout
  // (seen as `status: null`, a killed dangling process — NOT drift). Give these
  // subprocess tests an explicit generous budget so a real drift fails on the
  // assertion, not on a load-induced timeout. spawnSync gets its own slightly
  // smaller timeout so a genuinely-hung build still surfaces as a fast failure.
  const CHECK_TIMEOUT_MS = 60_000;

  test("package.ts --check exits 0 (committed dist byte-matches a fresh regenerate)", () => {
    const res = spawnSync("bun", [PACKAGE_TS, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: CHECK_TIMEOUT_MS - 5_000,
    });
    // On drift the check prints the offending MISSING/DIFFERS/ORPHAN paths.
    if (res.status !== 0) {
      console.error(`package --check output:\n${res.stdout ?? ""}${res.stderr ?? ""}`);
    }
    expect(res.status).toBe(0);
  }, CHECK_TIMEOUT_MS);

  test("package.ts claude --check is clean (keystone byte-parity)", () => {
    const res = spawnSync("bun", [PACKAGE_TS, "claude", "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: CHECK_TIMEOUT_MS - 5_000,
    });
    if (res.status !== 0) {
      console.error(`package claude --check output:\n${res.stdout ?? ""}${res.stderr ?? ""}`);
    }
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[claude] --check: OK");
  }, CHECK_TIMEOUT_MS);
});
