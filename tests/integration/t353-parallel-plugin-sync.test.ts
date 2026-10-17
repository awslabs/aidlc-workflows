// t353-parallel-plugin-sync: SessionStart runs every installed plugin's sync hook at once.
//
// covers: file:core/tools/aidlc-plugin.ts
//
// WHAT. Several plugins that overlay the same stages are synced by separate
// processes started together, as a host does at session start. Each sync must
// leave its own plugin composed, so every plugin's record and stage fragment
// is present afterwards and no hook exits non-zero. The same holds for a team
// plugin, its base and test-pro where the host lists its plugins: the team
// plugin's sync composes its base first while the base's own sync does too,
// and afterwards plugin list says every one is current.
//
// WHY PROCESSES. The race is between a sync's copy of the project and another
// sync's commit; only separate processes contend for the project lock the way
// session-start hooks do.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude");
const TOOLS = join(CLAUDE_DIST, ".claude", "tools");
const TEST_PRO = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
const COMPOSE_HOOK = join(TEST_PRO, "hooks", "compose.ts");
const KEYS = ["alpha", "beta", "gamma", "delta"];
const ROUNDS = 3;
const TEMP: string[] = [];

afterEach(() => {
  for (const path of TEMP.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(path);
  return path;
}

// A plugin that adds one fragment to each of two stages every plugin shares.
function overlayPlugin(parent: string, key: string): string {
  const root = join(parent, `plugin-${key}`);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "contributions", "construction"), { recursive: true });
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: `aidlc-${key}`, version: "0.1.0" })}\n`,
  );
  writeFileSync(
    join(root, ".aidlc-plugin-projection.json"),
    `${JSON.stringify({ schema: 1, producer: "aidlc-plugin-build", plugin: key, harness: "claude" })}\n`,
  );
  cpSync(COMPOSE_HOOK, join(root, "hooks", "compose.ts"));
  for (const target of ["nfr-design", "build-and-test"]) {
    writeFileSync(
      join(root, "contributions", "construction", `${target}.md`),
      [
        "---",
        `target: ${target}`,
        `plugin: ${key}`,
        "fragments:",
        "  - anchor: end-of-steps",
        "    order: 100",
        "---",
        "",
        "## fragment: end-of-steps",
        "",
        `### Step (${key}): marker ${key}-${target}`,
        "",
      ].join("\n"),
    );
  }
  return root;
}

// A plugin from the plugin create scaffold, building on what `dependencies`
// names, built by the shipped builder.
function builtPlugin(parent: string, name: string, dependencies: string[]): string {
  const source = join(parent, "src", name);
  const created = spawnSync(process.execPath, [join(TOOLS, "aidlc-plugin-create.ts"), name, source], { encoding: "utf-8" });
  expect(created.status, created.stdout + created.stderr).toBe(0);
  const manifestPath = join(source, ".aidlc-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.dependencies = dependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const out = join(parent, "build", name);
  const built = spawnSync(process.execPath, [join(TOOLS, "aidlc-plugin-build.ts"), source, "claude", out], { encoding: "utf-8" });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  return out;
}

// A session-start hook names only its own plugin's root.
function hookEnv(project: string, pluginRoot: string | null, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_HARNESS_NAME: "claude",
    ...extra,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  delete env.AIDLC_PLUGIN_ROOT;
  if (pluginRoot !== null) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  return env;
}

function runSync(
  project: string,
  pluginRoot: string,
  extra: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [join(project, ".claude", "tools", "aidlc-plugin.ts"), "sync"],
      { cwd: project, env: hookEnv(project, pluginRoot, extra) },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolveRun({ code: code ?? 1, stderr }));
  });
}

describe("t353 parallel plugin sync", () => {
  test("hooks started together leave every plugin composed", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const scratch = temp("aidlc-parallel-sync-");
      const project = join(scratch, "project");
      cpSync(CLAUDE_DIST, project, { recursive: true });
      const roots = KEYS.map((key) => overlayPlugin(scratch, key));

      const results = await Promise.all(roots.map((root) => runSync(project, root)));

      expect(results.map((result) => result.code), results.map((r) => r.stderr).join("\n")).toEqual(KEYS.map(() => 0));
      const stages = join(project, ".claude", "aidlc-common", "stages", "construction");
      for (const key of KEYS) {
        expect(existsSync(join(project, ".claude", "tools", "data", `plugin-compose-${key}.json`))).toBe(true);
        for (const target of ["nfr-design", "build-and-test"]) {
          expect(readFileSync(join(stages, `${target}.md`), "utf-8")).toContain(`marker ${key}-${target}`);
        }
      }
    }
  });

  test("a team plugin, its base and test-pro started together where the host lists its plugins all end current", async () => {
    const scratch = temp("aidlc-parallel-layered-");
    const installed: Record<string, string> = {
      zeta: builtPlugin(scratch, "zeta", ["core"]),
      alpha: builtPlugin(scratch, "alpha", ["core", "zeta@^0.1.0"]),
      "test-pro": TEST_PRO,
    };
    const registry = join(scratch, "installed_plugins.json");
    const settings = join(scratch, "settings.json");
    const plugins = Object.fromEntries(Object.entries(installed).map(([name, root]) => [
      `aidlc-${name}@aidlc-plugins`,
      [{ scope: "user", installPath: root, version: "0.1.0" }],
    ]));
    writeFileSync(registry, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
    writeFileSync(settings, "{}\n");
    const host = { AIDLC_CLAUDE_PLUGIN_REGISTRY: registry, AIDLC_CLAUDE_SETTINGS: settings };
    for (let round = 0; round < ROUNDS; round++) {
      const project = join(scratch, `project-${round}`);
      cpSync(CLAUDE_DIST, project, { recursive: true });

      const results = await Promise.all(Object.values(installed).map((root) => runSync(project, root, host)));

      expect(results.map((result) => result.code), results.map((r) => r.stderr).join("\n")).toEqual([0, 0, 0]);
      const listed = spawnSync(process.execPath, [join(project, ".claude", "tools", "aidlc-plugin.ts"), "list", "--json"], {
        cwd: project,
        encoding: "utf-8",
        env: hookEnv(project, null, host),
      });
      const statuses = (JSON.parse(listed.stdout) as { data: { statuses: Array<{ key: string; state: string }> } }).data.statuses;
      expect(statuses.map((status) => `${status.key} ${status.state}`).sort()).toEqual([
        "alpha current",
        "test-pro current",
        "zeta current",
      ]);
    }
  });
});
