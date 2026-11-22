// Plugin folders the `aidlc plugin test` verb is checked against (t327 on the
// copy channel, t-native-plugin-test on a native install), each beside the
// shipped runner, `bun <tools>/aidlc-plugin-test.ts`: test-pro as it ships; a
// test-pro whose stage collides with core's build-and-test, which compose drops
// (exit 1); and alpha, built on zeta, which composes into a bare install only
// with --with naming zeta's checkout (t316 has the same pair).

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

export type PluginTestFixtures = {
  clean: string;
  colliding: string;
  alpha: string;
  zeta: string;
};

const COLLIDING_STAGE = `---
slug: build-and-test
name: Colliding Build and Test
plugin: test-pro
phase: construction
execution: ALWAYS
condition: always
lead_agent: aidlc-quality-agent
support_agents: []
mode: inline
produces:
  - test-pro-collision-output
consumes: []
requires_stage: []
sensors: []
scopes:
  - enterprise
inputs: none
outputs: none
---

# Collision
`;

export function writePluginTestFixtures(root: string, toolsDir: string): PluginTestFixtures {
  const clean = join(root, "clean", "test-pro");
  const colliding = join(root, "colliding", "test-pro");
  for (const target of [clean, colliding]) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPO_ROOT, "plugins", "test-pro"), target, { recursive: true });
  }
  writeFileSync(join(colliding, "stages", "construction", "build-and-test.md"), COLLIDING_STAGE, "utf-8");

  const create = (name: string): string => {
    const pluginRoot = join(root, "layered", name);
    const created = spawnSync(process.execPath, [join(toolsDir, "aidlc-plugin-create.ts"), name, pluginRoot], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    if (created.status !== 0) throw new Error(`plugin create ${name} failed: ${created.stderr}`);
    return pluginRoot;
  };
  const zeta = create("zeta");
  const alpha = create("alpha");
  const manifestPath = join(alpha, ".aidlc-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.dependencies = ["core", "zeta@^0.1.0"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  const stagePath = join(alpha, "stages", "construction", "alpha-example-stage.md");
  writeFileSync(
    stagePath,
    readFileSync(stagePath, "utf-8")
      .replace("lead_agent: alpha-example-agent", "lead_agent: zeta-example-agent")
      .replace("requires_stage: []", "requires_stage:\n  - zeta-example-stage"),
    "utf-8",
  );
  return { clean, colliding, alpha, zeta };
}

export type PluginTestRun = { status: number | null; stdout: string; stderr: string };

// The option forms a help text lists, one per row that starts with "--".
export function helpOptionForms(help: string): string[] {
  return help.split("\n").filter((line) => /^ {2}--/.test(line)).map((line) => line.trim().split(/\s{2,}/)[0]);
}

// A --json result without what differs between two runs of the same test:
// the temporary candidate folder and the time a drop was recorded.
export function comparablePluginTest(stdout: string): unknown {
  return JSON.parse(
    stdout
      .replace(/[^"\s]*aidlc-plugin-test-[A-Za-z0-9]+/g, "<candidate>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>"),
  );
}

// The shipped runner, as the guide gives it for a copied tools folder.
export function runShippedPluginTest(
  toolsDir: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginTestRun {
  const result = spawnSync(process.execPath, [join(toolsDir, "aidlc-plugin-test.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}
