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
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const CHECK_TIMEOUT_MS = 60_000;

type Run = ReturnType<typeof spawnSync>;

function copyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true });
}

function makeFixture(harness: string, sourceHarness = harness): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-package-contract-"));
  copyDir(join(REPO_ROOT, "core"), join(root, "core"));
  copyDir(join(REPO_ROOT, "scripts"), join(root, "scripts"));
  mkdirSync(join(root, "harness"), { recursive: true });
  copyDir(join(REPO_ROOT, "harness", sourceHarness), join(root, "harness", harness));
  if (harness === sourceHarness) {
    mkdirSync(join(root, "dist"), { recursive: true });
    copyDir(join(REPO_ROOT, "dist", harness), join(root, "dist", harness));
  }
  return root;
}

function runPackage(root: string, ...args: string[]): Run {
  return spawnSync("bun", [join(root, "scripts", "package.ts"), ...args], {
    cwd: root,
    encoding: "utf-8",
    timeout: CHECK_TIMEOUT_MS - 5_000,
  });
}

function output(run: Run): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function replaceOnce(file: string, from: string, to: string): void {
  const before = readFileSync(file, "utf-8");
  expect(before.split(from)).toHaveLength(2);
  writeFileSync(file, before.replace(from, to));
}

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

describe("t145 packager contract regressions", () => {
  test("a synthetic harness passes its manifest harnessDir to graph and runner tools", () => {
    const root = makeFixture("foo", "claude");
    try {
      const manifest = join(root, "harness", "foo", "manifest.ts");
      replaceOnce(manifest, 'name: "claude"', 'name: "foo"');
      replaceOnce(manifest, 'harnessDir: ".claude"', 'harnessDir: ".foo"');

      // A first build still needs the harness-neutral stage number/name seed.
      for (const file of ["stage-graph.json", "scope-grid.json"]) {
        const src = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", file);
        const dst = join(root, "dist", "claude", ".claude", "tools", "data", file);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst);
      }

      const run = runPackage(root, "foo");
      expect(output(run)).toContain("[foo] regenerated dist/foo/.foo");
      expect(run.status).toBe(0);

      const generated = join(root, "dist", "foo", ".foo");
      const descriptor = JSON.parse(
        readFileSync(join(generated, "tools", "data", "harness.json"), "utf-8"),
      );
      const graph = readFileSync(
        join(generated, "tools", "data", "stage-graph.json"),
        "utf-8",
      );
      const runner = readFileSync(
        join(generated, "skills", "aidlc-init", "SKILL.md"),
        "utf-8",
      );
      expect(descriptor.harnessDir).toBe(".foo");
      expect(graph).toContain('"path": ".foo/sensors/');
      expect(graph).not.toContain('"path": ".claude/sensors/');
      expect(runner).toContain("bun .foo/tools/aidlc-utility.ts");
      expect(runner).not.toContain("bun .claude/tools/aidlc-utility.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  test("write mode preserves the compile seed when an existing harnessDir is renamed", () => {
    const root = makeFixture("claude");
    try {
      const manifest = join(root, "harness", "claude", "manifest.ts");
      replaceOnce(manifest, 'harnessDir: ".claude"', 'harnessDir: ".foo"');

      const run = runPackage(root, "claude");
      expect(output(run)).toContain("[claude] regenerated dist/claude/.foo");
      expect(run.status).toBe(0);
      expect(existsSync(join(root, "dist", "claude", ".claude"))).toBe(false);

      const generated = join(root, "dist", "claude", ".foo");
      expect(
        readFileSync(join(generated, "tools", "data", "stage-graph.json"), "utf-8"),
      ).toContain('"path": ".foo/sensors/');
      expect(
        readFileSync(join(generated, "skills", "aidlc-init", "SKILL.md"), "utf-8"),
      ).toContain("bun .foo/tools/aidlc-utility.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  test("an explicitly named harness without a manifest exits nonzero", () => {
    const root = makeFixture("kiro");
    try {
      const run = runPackage(root, "does-not-exist");
      expect(run.status).not.toBe(0);
      expect(output(run)).toContain('unknown harness "does-not-exist"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  for (const harness of ["kiro", "kiro-ide"]) {
    test(`${harness} --check detects a modified project-root AGENTS.md`, () => {
      const root = makeFixture(harness);
      try {
        appendFileSync(join(root, "dist", harness, "AGENTS.md"), "\nmodified in fixture\n");
        const run = runPackage(root, harness, "--check");
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain(`DIFFERS: ${harness}/AGENTS.md`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, CHECK_TIMEOUT_MS);
  }

  for (const [harness, file] of [
    ["claude", ".mcp.json"],
    ["claude", ".gitignore"],
  ] as const) {
    test(`${harness} --check detects modified root config ${file}`, () => {
      const root = makeFixture(harness);
      try {
        appendFileSync(join(root, "dist", harness, file), "\nmodified in fixture\n");
        const run = runPackage(root, harness, "--check");
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain(`DIFFERS: ${harness}/${file}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, CHECK_TIMEOUT_MS);
  }

  test("--check reports a removed root .mcp.json output as an orphan", () => {
    const root = makeFixture("claude");
    try {
      const manifest = join(root, "harness", "claude", "manifest.ts");
      replaceOnce(
        manifest,
        '    { src: ".mcp.json", dst: ".mcp.json", projectRoot: true },\n',
        "",
      );
      const run = runPackage(root, "claude", "--check");
      expect(run.status).not.toBe(0);
      expect(output(run)).toContain("ORPHAN in dist: claude/.mcp.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  test("--check reports a renamed root .gitignore output as an orphan", () => {
    const root = makeFixture("claude");
    try {
      const manifest = join(root, "harness", "claude", "manifest.ts");
      replaceOnce(manifest, 'dst: ".gitignore"', 'dst: ".gitignore.next"');
      const run = runPackage(root, "claude", "--check");
      const combined = output(run);
      expect(run.status).not.toBe(0);
      expect(combined).toContain("MISSING in dist: claude/.gitignore.next");
      expect(combined).toContain("ORPHAN in dist: claude/.gitignore");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  test("--check reports a renamed root AGENTS.md output as an orphan", () => {
    const root = makeFixture("kiro");
    try {
      const manifest = join(root, "harness", "kiro", "manifest.ts");
      replaceOnce(manifest, 'onboarding: { dst: "AGENTS.md"', 'onboarding: { dst: "AGENTS.next.md"');
      const run = runPackage(root, "kiro", "--check");
      const combined = output(run);
      expect(run.status).not.toBe(0);
      expect(combined).toContain("MISSING in dist: kiro/AGENTS.next.md");
      expect(combined).toContain("ORPHAN in dist: kiro/AGENTS.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  test("--check reports an authored harness file removed from the manifest as an orphan", () => {
    const root = makeFixture("kiro");
    try {
      const manifest = join(root, "harness", "kiro", "manifest.ts");
      replaceOnce(
        manifest,
        '    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },\n',
        "",
      );
      const run = runPackage(root, "kiro", "--check");
      expect(run.status).not.toBe(0);
      expect(output(run)).toContain(
        "ORPHAN in dist: kiro/.kiro/hooks/aidlc-kiro-adapter.ts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);

  test("write mode replaces only the named generated root", () => {
    const root = makeFixture("kiro");
    try {
      const stale = join(root, "dist", "kiro", "removed-root-output.txt");
      const pluginAsset = join(root, "dist", "plugins", "fixture", "keep.txt");
      const unrelatedAsset = join(root, "dist", "unrelated-root-asset.txt");
      writeFileSync(stale, "stale\n");
      mkdirSync(dirname(pluginAsset), { recursive: true });
      writeFileSync(pluginAsset, "keep plugin\n");
      writeFileSync(unrelatedAsset, "keep root\n");

      const run = runPackage(root, "kiro");
      expect(run.status).toBe(0);
      expect(existsSync(stale)).toBe(false);
      expect(readFileSync(pluginAsset, "utf-8")).toBe("keep plugin\n");
      expect(readFileSync(unrelatedAsset, "utf-8")).toBe("keep root\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHECK_TIMEOUT_MS);
});
