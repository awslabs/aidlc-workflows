// The retrospective plugin's own content validation + compose check.
//
// Distinct from the framework compose guard: this checks the plugin's authored
// content before packaging, then proves it composes into a real install and
// that its stage reaches the compiled stage graph gated on its opt-in scope.
//
// Run: bun test plugins/retrospective/tests/plugin.test.ts

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../../../tests/harness/test-budget.ts";
import {
  composePluginFixture,
  validatePluginContent,
  walkMarkdownFiles,
} from "../../../tests/harness/plugin-kit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

describe("retrospective plugin own content validation", () => {
  test("passes the reusable plugin content validator", () => {
    expect(validatePluginContent(PLUGIN_ROOT)).toEqual([]);
  });

  test("ships exactly one stage and its opt-in scope", () => {
    expect(walkMarkdownFiles(join(PLUGIN_ROOT, "stages")).length).toBe(1);
    expect(walkMarkdownFiles(join(PLUGIN_ROOT, "scopes")).length).toBe(1);
  });
});

describe("retrospective plugin composes into a Claude install", () => {
  const scratch: string[] = [];

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  test("the retrospective stage reaches the compiled stage graph", () => {
    const fixture = composePluginFixture({
      plugin: "retrospective",
      harness: "claude",
    });
    scratch.push(dirname(fixture.projectDir));

    expect(fixture.dropLogs).toBe("");

    const graph = JSON.parse(
      readFileSync(
        join(
          fixture.projectDir,
          ".claude",
          "tools",
          "data",
          "stage-graph.json",
        ),
        "utf-8",
      ),
    ) as Array<{ slug?: string; scopes?: string[]; plugin?: string }>;

    const stage = graph.find((s) => s.slug === "retrospective-ceremony");
    expect(stage, "retrospective stage missing from compiled graph").toBeDefined();

    // Opt-in only: gated solely on its own scope, never leaked into a core scope,
    // so no install that has not selected it meets a new gate.
    const coreScopes = [
      "classic",
      "enterprise",
      "feature",
      "mvp",
      "poc",
      "bugfix",
      "workshop",
      "infra",
      "refactor",
      "express",
      "security-patch",
    ];
    expect(stage?.scopes ?? []).toEqual(["retrospective-ceremony"]);
    expect(
      (stage?.scopes ?? []).filter((s) => coreScopes.includes(s)),
    ).toEqual([]);
  });
});
