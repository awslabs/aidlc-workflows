// covers: subcommand:aidlc-utility:plugin-validate subcommand:aidlc-utility:plugin-build subcommand:aidlc-utility:plugin-catalog

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
    expect(files(outDir)).toEqual(files(EXPECTED));
    for (const file of files(EXPECTED)) {
      expect(readFileSync(join(outDir, file))).toEqual(
        readFileSync(join(EXPECTED, file)),
      );
    }
  });

  test("plugin catalog publishes a projection tree through the public dispatcher", () => {
    const marketplace = join(scratch, "marketplace");
    cpSync(join(REPO_ROOT, "dist", "plugins"), marketplace, { recursive: true });
    const result = run(["plugin", "catalog", marketplace, "--name", "team-plugins", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, ok: true, code: 0, status: "ok" });
    const catalog = JSON.parse(readFileSync(join(marketplace, "aidlc-marketplace.json"), "utf-8"));
    expect(catalog).toEqual(envelope.data.catalog);
    expect(catalog.name).toBe("team-plugins");
    expect(catalog.plugins.find((plugin: { name: string }) => plugin.name === "test-pro").harnesses.claude.path)
      .toBe("test-pro/claude");
    expect(existsSync(join(marketplace, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(existsSync(join(marketplace, ".codex-plugin", "marketplace.json"))).toBe(true);
  });

  test("catalog and search help require neither a marketplace nor an installed project", () => {
    const before = files(pluginRoot).map((file) => [file, readFileSync(join(pluginRoot, file))]);
    for (const verb of ["catalog", "search"]) {
      const result = run(["plugin", verb, "--help"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`aidlc plugin ${verb}`);
    }
    expect(files(pluginRoot).map((file) => [file, readFileSync(join(pluginRoot, file))])).toEqual(before);
    expect(existsSync(join(pluginRoot, "aidlc.settings.json"))).toBe(false);
  });
});
