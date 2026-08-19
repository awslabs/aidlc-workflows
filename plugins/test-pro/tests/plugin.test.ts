// The test-pro plugin's own content validation.
//
// Distinct from the framework compose guard: this checks the plugin's authored
// content before packaging. Copy this shape for your own plugin.
//
// Run: bun test plugins/test-pro/tests/plugin.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePluginContent,
  walkMarkdownFiles,
} from "../../../tests/harness/plugin-kit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const REPO_ROOT = join(PLUGIN_ROOT, "..", "..");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const MEMORY_DIST = join(REPO_ROOT, "dist", "claude", "aidlc");
const PLUGIN_DIST = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
const PLUGIN_NAME = "test-pro";

describe("test-pro plugin own content validation", () => {
  test("passes the reusable plugin content validator", () => {
    expect(validatePluginContent(PLUGIN_ROOT)).toEqual([]);
  });

  test("ships stages and contributions", () => {
    expect(walkMarkdownFiles(join(PLUGIN_ROOT, "stages")).length).toBeGreaterThan(0);
    expect(
      walkMarkdownFiles(join(PLUGIN_ROOT, "contributions")).length,
    ).toBeGreaterThan(0);
  });
});

describe(`${PLUGIN_NAME} plugin — composed doctor check`, () => {
  let tmp = "";
  let project = "";

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-test-pro-doctor-"));
    project = join(tmp, "project");
    mkdirSync(project, { recursive: true });
    cpSync(CLAUDE_DIST, join(project, ".claude"), { recursive: true });
    cpSync(MEMORY_DIST, join(project, "aidlc"), { recursive: true });
    const compose = spawnSync(process.execPath, [join(PLUGIN_DIST, "hooks", "compose.ts")], {
      cwd: project,
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_DIST,
        CLAUDE_PROJECT_DIR: project,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    if (compose.status !== 0) {
      throw new Error(`test-pro compose failed: ${compose.stderr ?? compose.stdout}`);
    }
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("doctor surfaces the plugin's reference checks after compose", () => {
    const doctor = spawnSync(
      process.execPath,
      [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor", "--project-dir", project],
      {
        cwd: project,
        encoding: "utf-8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_HARNESS_DIR: ".claude",
        },
      },
    );
    expect(doctor.status, `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`).toBe(0);
    expect(doctor.stdout).toContain("Plugin check (test-pro):");
  });
});
