// covers: file:scripts/package-sources.ts
//
// Tools that read dist/ must not report on code that has since changed. The
// packager records a content fingerprint of its inputs per harness tree, and
// the coverage generator refuses, naming the one command to run, when the tree
// it reads was packaged from other sources than the checkout.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetPackagedSources, PACKAGE_SOURCES_FILE, packageInputsFingerprint, recordPackagedSources, stalePackageMessage,
} from "../../scripts/package-sources.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const GENERATOR = join(import.meta.dir, "..", "gen-coverage-registry.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A checkout with one file in each packaged input and a dist/ directory. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-package-sources-"));
  roots.push(root);
  for (const [path, body] of [
    ["core/tools/example.ts", "export const x = 1;\n"],
    ["harness/claude/manifest.ts", "export default {};\n"],
    ["plugins/demo/stages/s.md", "# s\n"],
    ["plugins/demo/tests/t.test.ts", "// a plugin test\n"],
    ["scripts/package.ts", "// packager\n"],
    ["scripts/plugin-hooks-template/compose.ts", "// compose\n"],
  ] as const) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  mkdirSync(join(root, "dist"));
  return root;
}

describe("the packaged-sources fingerprint", () => {
  test("changes with a packaged input and comes back when the edit is undone", () => {
    const root = checkout();
    const before = packageInputsFingerprint(root);
    expect(packageInputsFingerprint(root)).toBe(before);
    writeFileSync(join(root, "core/tools/example.ts"), "export const x = 2;\n");
    expect(packageInputsFingerprint(root)).not.toBe(before);
    writeFileSync(join(root, "core/tools/example.ts"), "export const x = 1;\n");
    expect(packageInputsFingerprint(root)).toBe(before);
  });

  test.each([
    ["harness/claude/manifest.ts"],
    ["plugins/demo/stages/s.md"],
    ["scripts/package.ts"],
    ["scripts/plugin-hooks-template/compose.ts"],
  ])("covers %s", (path) => {
    const root = checkout();
    const before = packageInputsFingerprint(root);
    writeFileSync(join(root, path), "changed\n");
    expect(packageInputsFingerprint(root)).not.toBe(before);
  });

  test("ignores what the packager never reads: plugin tests, node_modules, the rest of scripts/ and tests/", () => {
    const root = checkout();
    const before = packageInputsFingerprint(root);
    writeFileSync(join(root, "plugins/demo/tests/t.test.ts"), "// edited\n");
    mkdirSync(join(root, "core/node_modules/dep"), { recursive: true });
    writeFileSync(join(root, "core/node_modules/dep/index.js"), "x");
    writeFileSync(join(root, "scripts/ci-other.ts"), "x");
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/t1.test.ts"), "x");
    expect(packageInputsFingerprint(root)).toBe(before);
  });
});

describe("the packaged-sources record", () => {
  test("a tree with no record, or an unreadable one, is reported as never packaged", () => {
    const root = checkout();
    const missing = "dist/claude has no record of the sources it was packaged from: run `bun scripts/package.ts` first.";
    expect(stalePackageMessage(root, "claude")).toBe(missing);
    writeFileSync(join(root, PACKAGE_SOURCES_FILE), "{");
    expect(stalePackageMessage(root, "claude")).toBe(missing);
  });

  test("a recorded tree is current until a packaged input changes", () => {
    const root = checkout();
    recordPackagedSources(root, ["claude", "kiro"], packageInputsFingerprint(root));
    expect(stalePackageMessage(root, "claude")).toBeNull();
    writeFileSync(join(root, "core/tools/example.ts"), "export const x = 2;\n");
    expect(stalePackageMessage(root, "claude")).toBe(
      "dist/claude was packaged from other sources than this checkout: run `bun scripts/package.ts` first.",
    );
  });

  test("a one-harness build updates its own entry and keeps the others", () => {
    const root = checkout();
    recordPackagedSources(root, ["claude", "kiro"], packageInputsFingerprint(root));
    writeFileSync(join(root, "core/tools/example.ts"), "export const x = 2;\n");
    recordPackagedSources(root, ["kiro"], packageInputsFingerprint(root));
    expect(stalePackageMessage(root, "kiro")).toBeNull();
    expect(stalePackageMessage(root, "claude")).toContain("was packaged from other");
    expect(Object.keys(JSON.parse(readFileSync(join(root, PACKAGE_SOURCES_FILE), "utf8")).harnesses)).toEqual(["claude", "kiro"]);
  });

  test("a source edited while the build runs leaves its trees unrecorded, and says so to the caller", () => {
    const root = checkout();
    recordPackagedSources(root, ["claude"], packageInputsFingerprint(root));
    const builtFrom = packageInputsFingerprint(root);
    forgetPackagedSources(root, ["claude"]);
    writeFileSync(join(root, "core/tools/example.ts"), "export const x = 2;\n");
    expect(recordPackagedSources(root, ["claude"], builtFrom)).toBe(false);
    expect(stalePackageMessage(root, "claude")).toContain("has no record");
  });

  test("a build that stops halfway leaves its trees unrecorded, never current", () => {
    const root = checkout();
    recordPackagedSources(root, ["claude", "kiro"], packageInputsFingerprint(root));
    forgetPackagedSources(root, ["claude"]);
    expect(stalePackageMessage(root, "claude")).toContain("has no record");
    expect(stalePackageMessage(root, "kiro")).toBeNull();
    const fresh = checkout();
    forgetPackagedSources(fresh, ["claude"]);
    expect(existsSync(join(fresh, PACKAGE_SOURCES_FILE))).toBe(false);
  });
});

describe("the coverage generator on a stale dist/", () => {
  test("refuses in one line naming the command, before it reads or writes anything", () => {
    const root = checkout();
    recordPackagedSources(root, ["claude"], packageInputsFingerprint(root));
    writeFileSync(join(root, "core/tools/example.ts"), "export const x = 2;\n");
    const registry = join(root, "registry.json");
    writeFileSync(registry, "committed\n");
    for (const args of [["--check"], []]) {
      const run = spawnSync(process.execPath, [GENERATOR, ...args], {
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        env: { ...process.env, AIDLC_COVERAGE_SRC_ROOT: root, AIDLC_COVERAGE_TESTS_DIR: join(root, "tests"), AIDLC_COVERAGE_REGISTRY: registry },
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr.trim().split("\n")).toEqual([
        "coverage registry: dist/claude was packaged from other sources than this checkout: run `bun scripts/package.ts` first.",
      ]);
      expect(readFileSync(registry, "utf8")).toBe("committed\n");
    }
  });
});
