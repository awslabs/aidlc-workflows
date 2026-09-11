// covers: file:scripts/package.ts (plugin build), file:tests/harness/plugin-kit.ts

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import type { DriveResult } from "../harness/sdk-drive.ts";

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
  }, 60_000);

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

  test.skipIf(
    process.env.AIDLC_CLAUDE_SDK_LIVE !== "1" ||
      process.env.AIDLC_NO_LLM === "1" ||
      !Bun.which("claude"),
  )("Claude lists the composed test-pro plugin through the live harness", async () => {
    const fixture = composePluginFixture({
      plugin: "test-pro",
      harness: "claude",
      projectDir: join(tmp, "live-claude-project"),
    });
    const manifest = JSON.parse(
      readFileSync(join(fixture.pluginBuilt, ".claude-plugin", "plugin.json"), "utf-8"),
    ) as { name: string; version: string };
    // Supply only this fixture's host inventory; the SDK owns an isolated config dir.
    const registry = join(tmp, "live-installed-plugins.json");
    const settings = join(tmp, "live-settings.json");
    writeFileSync(registry, JSON.stringify({
      version: 2,
      plugins: {
        [`${manifest.name}@fixture`]: [{
          installPath: fixture.pluginBuilt,
          version: manifest.version,
        }],
      },
    }));
    writeFileSync(settings, "{}");
    const pluginEnv = {
      AIDLC_CLAUDE_PLUGIN_REGISTRY: registry,
      AIDLC_CLAUDE_SETTINGS: settings,
    };
    // The fixture composer installs content; native sync also records its provenance.
    const sync = spawnSync(process.execPath, [
      join(fixture.projectDir, ".claude", "tools", "aidlc.ts"),
      "engine", "plugin", "sync", "--project-dir", fixture.projectDir, "--json",
    ], {
      cwd: fixture.projectDir,
      env: { ...process.env, ...pluginEnv },
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
    });
    expect(sync.status, sync.stderr || sync.stdout).toBe(0);
    expect(JSON.parse(sync.stdout)).toMatchObject({
      ok: true,
      data: { synced: ["test-pro"] },
    });

    const invocation = await invokeHarness(
      fixture.projectDir,
      "claude",
      "/aidlc plugin list --json",
      {
        claude: {
          timeoutMs: 300_000,
          persistSession: true,
          env: pluginEnv,
        },
      },
    );
    expect(invocation.status).toBe("completed");
    if (invocation.status !== "completed") {
      throw new Error(invocation.reason);
    }
    const result = invocation.result as DriveResult;
    expect(result.timedOut).toBe(false);
    expect(result.resultEvent?.subtype).toBe("success");
    expect(result.resultEvent?.is_error).toBe(false);
    expect(result.resultEvent?.permissionDenialsCount).toBe(0);
    expect(result.toolResults.filter((tool) => tool.isError)).toEqual([]);
    const listCall = result.toolResults.find((tool) =>
      tool.toolName === "Bash" &&
      /\bplugin\s+list\s+--json\b/.test(String(tool.input.command)) &&
      !/\borchestrate\b/.test(String(tool.input.command))
    );
    expect(listCall).toBeDefined();
    if (!listCall) throw new Error("Claude did not execute plugin list --json");
    console.log("Claude plugin list tool result:", listCall.resultText);
    const output = JSON.parse(listCall.resultText);
    expect(output).toMatchObject({ ok: true, code: 0, status: "ok" });
    expect(output.data.inventory.capability).toBe("full-inventory");
    expect(output.data.inventory.invalid).toEqual([]);
    expect(output.data.inventory.installed).toContainEqual(expect.objectContaining({
      key: "test-pro",
      enabled: true,
      version: manifest.version,
    }));
    expect(output.data.statuses).toContainEqual(expect.objectContaining({
      key: "test-pro",
      installedVersion: manifest.version,
      composedVersion: manifest.version,
      state: "current",
      action: "current",
    }));
    expect(graphSlugs(fixture.projectDir, ".claude")).toContain("test-pro-integration");
    expect(result.askedQuestions).toEqual([]);
    expect(result.stateFile).toBeUndefined();
  }, 360_000);
});
