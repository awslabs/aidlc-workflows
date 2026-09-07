#!/usr/bin/env bun
// Cross-platform plugin compose launcher for hosts whose hook commands must
// run on native Windows. Avoid `sh -c`: prefer an installed aidlc executable,
// then fall back to the sibling compose.ts with this Bun executable.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = process.argv[2] || ".cursor";
const harnessName = process.argv[3] || process.env.AIDLC_HARNESS_NAME;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rawInput = process.stdin.isTTY ? "" : await Bun.stdin.text();

function installedProject(path: string): string | null {
  const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
  return existsSync(join(resolved, harnessDir, "tools", "aidlc-graph.ts"))
    ? resolved
    : null;
}

function projectFromPayload(): string | null {
  const explicit =
    process.env.AIDLC_PROJECT_DIR ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR;
  if (explicit) {
    const project = installedProject(explicit);
    if (project === null) {
      process.stderr.write(
        `aidlc plugin compose: explicit project root does not contain an AI-DLC ${harnessDir} install: ${explicit}\n`,
      );
      process.exit(1);
    }
    return project;
  }

  let roots: string[] = [];
  try {
    const parsed = JSON.parse(rawInput) as { workspace_roots?: unknown };
    if (Array.isArray(parsed.workspace_roots)) {
      roots = parsed.workspace_roots.filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      );
    }
  } catch {
    // Fall through to cwd for manual/source-tree invocations.
  }
  const projects = [...new Set(roots.map(installedProject).filter((p): p is string => p !== null))];
  if (projects.length > 1) {
    process.stderr.write(
      `aidlc plugin compose: multiple Cursor workspace roots contain AI-DLC installs (${projects.join(", ")}); set AIDLC_PROJECT_DIR to select one\n`,
    );
    process.exit(1);
  }
  if (projects.length === 1) return projects[0];
  return installedProject(process.cwd());
}

const projectRoot = projectFromPayload();
if (projectRoot === null) process.exit(0);

const env = {
  ...process.env,
  AIDLC_HARNESS_DIR: harnessDir,
  ...(harnessName ? { AIDLC_HARNESS_NAME: harnessName } : {}),
  AIDLC_PLUGIN_ROOT: pluginRoot,
  AIDLC_PROJECT_DIR: projectRoot,
  CLAUDE_PROJECT_DIR: projectRoot,
  CURSOR_PROJECT_DIR: projectRoot,
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  PLUGIN_ROOT: pluginRoot,
};
const aidlc = Bun.which("aidlc");

if (aidlc) {
  const synced = spawnSync(aidlc, ["plugin", "sync"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  if (synced.status === 0) process.exit(0);
}

const compose = join(pluginRoot, "hooks", "compose.ts");
const fallback = spawnSync(process.execPath, [compose], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});
process.exit(fallback.status ?? 1);
