// covers: subcommand:aidlc-utility:plugin-validate subcommand:aidlc-utility:plugin-build

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { asShippedBuild } from "../harness/plugin-host-names.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const DISPATCHER = join(TOOLS, "aidlc.ts");
const SOURCE_PLUGIN = join(REPO_ROOT, "plugins", "test-pro");
const EXPECTED = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t327-"));
const pluginRoot = join(scratch, "test-pro");
cpSync(SOURCE_PLUGIN, pluginRoot, { recursive: true });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], cwd = pluginRoot) {
  const result = spawnSync(process.execPath, [DISPATCHER, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_DISPATCH_TOOLS_DIR: TOOLS },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out;
}

describe("t327 top-level plugin authoring routes", () => {
  test("plugin validate delegates to the shipped standalone validator", () => {
    const result = run(["plugin", "validate", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("plugin validate passes --with <base-root> to the validator", () => {
    // test-pro builds on core alone, so the validator itself answers --with.
    const result = run(["plugin", "validate", pluginRoot, "--with", scratch, "--json"], scratch);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).errors).toMatchObject([
      { rule: "base-root", message: `--with names ${scratch}, but this plugin builds on core alone` },
    ]);
    const bare = run(["plugin", "validate", pluginRoot, "--with"], scratch);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("--with <base-root>");
  });

  test("plugin build delegates to the shared emitter with --plugin-root", () => {
    const outDir = join(scratch, "built");
    const result = run(
      [
        "plugin",
        "build",
        "claude",
        outDir,
        "--plugin-root",
        pluginRoot,
        "--json",
      ],
      scratch,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).valid).toBe(true);
    // The shipped route builds test-pro under its own names; the packager's
    // tree is AI-DLC's own, aidlc-test-pro in aidlc-plugins.
    const expected = asShippedBuild("claude")(
      new Map(files(EXPECTED).map((file) => [file, readFileSync(join(EXPECTED, file))])),
    );
    expect(files(outDir).sort()).toEqual([...expected.keys()].sort());
    for (const [file, bytes] of expected) {
      expect(readFileSync(join(outDir, file)).equals(bytes), file).toBe(true);
    }
  });
});
