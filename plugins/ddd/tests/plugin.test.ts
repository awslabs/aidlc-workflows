// The ddd plugin's own content validation and compose smoke.
//
// Distinct from the framework compose guard (t188): this checks the plugin's
// authored content before packaging, then composes the built claude projection
// into a disposable install and asserts the DDD surfaces actually land.
//
// Run: bun test plugins/ddd/tests/plugin.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composePluginFixture,
  validatePluginContent,
  walkMarkdownFiles,
} from "../../../tests/harness/plugin-kit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const PLUGIN_NAME = "ddd";

describe("ddd plugin own content validation", () => {
  test("passes the reusable plugin content validator", () => {
    expect(validatePluginContent(PLUGIN_ROOT)).toEqual([]);
  });

  test("ships stages, contributions, sensor, scope, and knowledge", () => {
    expect(walkMarkdownFiles(join(PLUGIN_ROOT, "stages")).length).toBe(2);
    expect(
      walkMarkdownFiles(join(PLUGIN_ROOT, "contributions")).length,
    ).toBe(5);
    expect(
      existsSync(join(PLUGIN_ROOT, "sensors", "aidlc-ddd-conformance.md")),
    ).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, "scopes", "ddd-modeling.md"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(
          PLUGIN_ROOT,
          "knowledge",
          "aidlc-architect-agent",
          "ddd-modeling-method.md",
        ),
      ),
    ).toBe(true);
  });

  test("both stages bind their reviewer to a produced review_artifact", () => {
    for (const [stage, artifact] of [
      ["stages/inception/ddd-domain-modeling.md", "ddd-domain-model"],
      ["stages/construction/ddd-conformance.md", "ddd-conformance-results"],
    ]) {
      const body = readFileSync(join(PLUGIN_ROOT, stage), "utf-8");
      expect(body, stage).toContain(`review_artifact: ${artifact}`);
    }
  });
});

describe(`${PLUGIN_NAME} plugin — composed into a disposable claude install`, () => {
  let projectDir = "";
  let tmpRoot = "";

  beforeAll(() => {
    const fixture = composePluginFixture({
      plugin: PLUGIN_NAME,
      harness: "claude",
    });
    projectDir = fixture.projectDir;
    tmpRoot = dirname(projectDir);
  }, 120_000);

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("both DDD stages land in the composed stage tree", () => {
    const stagesDir = join(projectDir, ".claude", "aidlc-common", "stages");
    expect(
      existsSync(join(stagesDir, "inception", "ddd-domain-modeling.md")),
    ).toBe(true);
    expect(
      existsSync(join(stagesDir, "construction", "ddd-conformance.md")),
    ).toBe(true);
  });

  test("contributions merge into all four core target stages", () => {
    const stagesDir = join(projectDir, ".claude", "aidlc-common", "stages");
    for (const target of [
      "inception/units-generation.md",
      "construction/functional-design.md",
      "construction/code-generation.md",
      "construction/build-and-test.md",
    ]) {
      const body = readFileSync(join(stagesDir, target), "utf-8");
      expect(body, target).toContain("plugin:ddd");
    }
  });

  test("requirements-analysis joins the ddd-modeling scope (standalone modeling path)", () => {
    const stagesDir = join(projectDir, ".claude", "aidlc-common", "stages");
    const ra = readFileSync(
      join(stagesDir, "inception", "requirements-analysis.md"),
      "utf-8",
    );
    expect(ra).toContain("- ddd-modeling");
    // The conformance gate stays out of the modeling-only scope.
    const gate = readFileSync(
      join(stagesDir, "construction", "ddd-conformance.md"),
      "utf-8",
    );
    expect(gate).not.toContain("- ddd-modeling");
  });

  test("sensor manifest, sensor tool, scope, and knowledge are copied", () => {
    const harnessDir = join(projectDir, ".claude");
    expect(
      existsSync(join(harnessDir, "sensors", "aidlc-ddd-conformance.md")),
    ).toBe(true);
    expect(
      existsSync(join(harnessDir, "tools", "aidlc-sensor-ddd-conformance.ts")),
    ).toBe(true);
    expect(existsSync(join(harnessDir, "scopes", "ddd-modeling.md"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(
          harnessDir,
          "knowledge",
          "aidlc-architect-agent",
          "ddd-modeling-method.md",
        ),
      ),
    ).toBe(true);
  });
});
