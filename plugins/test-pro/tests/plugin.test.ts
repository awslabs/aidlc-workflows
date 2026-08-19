// The test-pro plugin's own content validation.
//
// Distinct from the framework compose guard: this checks the plugin's authored
// content before packaging. Copy this shape for your own plugin.
//
// Run: bun test plugins/test-pro/tests/plugin.test.ts

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePluginContent,
  walkMarkdownFiles,
} from "../../../tests/harness/plugin-kit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

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
