// t353-parallel-plugin-sync: SessionStart runs every installed plugin's sync hook at once.
//
// covers: file:core/tools/aidlc-plugin.ts
//
// WHAT. Several plugins that overlay the same stages are synced by separate
// processes started together, as a host does at session start. Each sync must
// leave its own plugin composed, so every plugin's record and stage fragment
// is present afterwards and no hook exits non-zero.
//
// WHY PROCESSES. The race is between a sync's copy of the project and another
// sync's commit; only separate processes contend for the project lock the way
// session-start hooks do.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude");
const COMPOSE_HOOK = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude", "hooks", "compose.ts");
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

function runSync(project: string, pluginRoot: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [join(project, ".claude", "tools", "aidlc-plugin.ts"), "sync"],
      {
        cwd: project,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_HARNESS_DIR: ".claude",
          AIDLC_HARNESS_NAME: "claude",
        },
      },
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
});
