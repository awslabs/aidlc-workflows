// covers: file:scripts/package.ts (plugin build), file:tests/harness/plugin-kit.ts

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
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
import {
  buildPluginProjection,
  composePluginFixture,
  type InvokableHarness,
  invokeHarness,
  liveGateFor,
  validatePluginContent,
} from "../harness/plugin-kit.ts";

const TIMEOUT_MS = 60_000;
setDefaultTimeout(TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_PRO_ROOT = join(REPO_ROOT, "plugins", "test-pro");
const tmp = mkdtempSync(join(tmpdir(), "aidlc-t300-"));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function graphSlugs(projectDir: string, harnessDir: string): string[] {
  const graph = JSON.parse(
    readFileSync(
      join(projectDir, harnessDir, "tools", "data", "stage-graph.json"),
      "utf-8",
    ),
  ) as Array<{ slug?: string }>;
  return graph.map((stage) => String(stage.slug ?? ""));
}

describe("t300 reusable plugin test kit", () => {
  test("builds and composes test-pro for Claude and OpenCode", () => {
    const claudeBuilt = buildPluginProjection(
      "test-pro",
      "claude",
      join(tmp, "plugin-claude"),
    );
    expect(
      existsSync(join(claudeBuilt, ".claude-plugin", "plugin.json")),
    ).toBe(true);
    const claude = composePluginFixture({
      plugin: "test-pro",
      harness: "claude",
      projectDir: join(tmp, "claude-project"),
      pluginBuilt: claudeBuilt,
    });
    expect(graphSlugs(claude.projectDir, ".claude")).toContain(
      "test-pro-integration",
    );

    const opencode = composePluginFixture({
      plugin: "test-pro",
      harness: "opencode",
      projectDir: join(tmp, "opencode-project"),
    });
    expect(graphSlugs(opencode.projectDir, ".aidlc")).toContain(
      "test-pro-integration",
    );
  });

  test("validates good content and reports synthesized plugin findings", () => {
    expect(validatePluginContent(TEST_PRO_ROOT)).toEqual([]);

    const badRoot = join(tmp, "bad-plugin");
    mkdirSync(join(badRoot, ".aidlc-plugin"), { recursive: true });
    mkdirSync(join(badRoot, "stages", "construction"), { recursive: true });
    mkdirSync(join(badRoot, "contributions", "construction"), {
      recursive: true,
    });
    writeFileSync(
      join(badRoot, ".aidlc-plugin", "plugin.json"),
      JSON.stringify({
        name: "wrong-name",
        version: "0.1.0",
        aidlc: { contributes: { stages: "stages/" } },
      }),
    );
    writeFileSync(
      join(badRoot, "stages", "construction", "bad-stage.md"),
      [
        "---",
        "slug: bad-stage",
        "name: Bad Stage",
        "plugin: bad-plugin",
        "phase: construction",
        "execution: ALWAYS",
        "condition: always",
        "lead_agent: aidlc-quality-agent",
        "support_agents: []",
        "mode: inline",
        "produces:",
        "  - unnamespaced-output",
        "consumes: []",
        "requires_stage: []",
        "sensors: []",
        "scopes: []",
        "inputs: input",
        "outputs: output",
        "---",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(
        badRoot,
        "contributions",
        "construction",
        "missing-target.md",
      ),
      [
        "---",
        "target: nonexistent-stage",
        "plugin: bad-plugin",
        "adds:",
        "  produces:",
        "    - bad-plugin-output",
        "---",
        "",
      ].join("\n"),
    );

    const codes = new Set(
      validatePluginContent(badRoot).map((finding) => finding.code),
    );
    expect(codes).toContain("manifest-name");
    expect(codes).toContain("artifact-namespace");
    expect(codes).toContain("contribution-target");
    expect(codes).toContain("stage-body");
  });

  test("invokeHarness skips every dispatch when its live gate is unset", async () => {
    const harnesses: InvokableHarness[] = [
      "claude",
      "kiro",
      "codex",
      "copilot",
      "opencode",
      "cursor",
    ];
    const prior = new Map<string, string | undefined>();
    for (const harness of harnesses) {
      const gate = liveGateFor(harness);
      prior.set(gate, process.env[gate]);
      delete process.env[gate];
    }
    try {
      for (const harness of harnesses) {
        const result = await invokeHarness(tmp, harness, "--status");
        expect(result.status, harness).toBe("skipped");
        expect(result.liveGate, harness).toBe(liveGateFor(harness));
      }
    } finally {
      for (const [gate, value] of prior) {
        if (value === undefined) delete process.env[gate];
        else process.env[gate] = value;
      }
    }
  });
});
