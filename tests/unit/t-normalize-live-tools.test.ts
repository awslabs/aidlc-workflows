// The Windows live runtime normalizes installed tools: every hard-linked file
// becomes a private copy before the runner seals the tree. A scanner can hold a
// fresh executable open, so a rename over it may fail with EPERM for a moment;
// the normalizer retries that on Windows instead of failing the whole job.
import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { normalizeTools, replaceEntry } = require("../../.github/scripts/normalize-live-tools.cjs") as {
  normalizeTools: (root: string) => number;
  replaceEntry: (temporary: string, target: string, options?: {
    platform?: string;
    rename?: (from: string, to: string) => void;
    retryMs?: number;
  }) => void;
};

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function denied(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename failed`), { code });
}

function flakyRename(failures: number, code = "EPERM") {
  const calls: string[] = [];
  return {
    calls,
    rename(from: string, to: string) {
      calls.push(`${from}->${to}`);
      if (calls.length <= failures) throw denied(code);
    },
  };
}

describe("t-normalize-live-tools", () => {
  test("a hard-linked tool becomes a private copy and the other link keeps its bytes", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-normalize-")));
    scratch.push(root);
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "tool.exe"), "tool bytes");
    linkSync(join(root, "bin", "tool.exe"), join(root, "tool-link.exe"));

    // Copying one entry leaves the other as the only link to the original.
    expect(normalizeTools(root)).toBe(1);
    expect(statSync(join(root, "bin", "tool.exe")).nlink).toBe(1);
    expect(statSync(join(root, "tool-link.exe")).nlink).toBe(1);
    expect(readFileSync(join(root, "bin", "tool.exe"), "utf-8")).toBe("tool bytes");
    expect(readFileSync(join(root, "tool-link.exe"), "utf-8")).toBe("tool bytes");
  });

  test("Windows retries a rename a scanner briefly denies", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const flaky = flakyRename(2, code);
      replaceEntry("copy.tmp", "opencode.exe", { platform: "win32", rename: flaky.rename, retryMs: 5_000 });
      expect(flaky.calls).toHaveLength(3);
    }
  });

  test("the retry gives up at its deadline with the original error", () => {
    const flaky = flakyRename(Number.POSITIVE_INFINITY);
    expect(() => replaceEntry("copy.tmp", "opencode.exe", { platform: "win32", rename: flaky.rename, retryMs: 300 }))
      .toThrow("EPERM");
    expect(flaky.calls.length).toBeGreaterThan(1);
  });

  test("other errors, and every error off Windows, fail at once", () => {
    const missing = flakyRename(1, "ENOENT");
    expect(() => replaceEntry("copy.tmp", "tool", { platform: "win32", rename: missing.rename, retryMs: 5_000 }))
      .toThrow("ENOENT");
    expect(missing.calls).toHaveLength(1);

    const posix = flakyRename(1);
    expect(() => replaceEntry("copy.tmp", "tool", { platform: "linux", rename: posix.rename, retryMs: 5_000 }))
      .toThrow("EPERM");
    expect(posix.calls).toHaveLength(1);
  });
});
