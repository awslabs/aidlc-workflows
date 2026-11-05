// How AI-DLC starts a plugin's own script with its own runtime: the plugin's
// doctor check (aidlc-utility.ts appendPluginDoctorChecks) and a command the
// plugin names (aidlc.ts). One owner of that launch and its path boundary.
//
// Installing a plugin is the trust boundary for its code, so the script runs
// directly, never through a shell, with Bun: the person's Bun on a copy
// install, and on a native one the aidlc binary itself, which runs as Bun with
// BUN_BE_BUN=1. That variable is needed only to start it: the preload shipped
// beside the binary takes it out before the script runs, so an `aidlc` the
// script starts is the engine, not Bun. A runtime without the preload file
// starts the script without it, as before it shipped.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compiledExecutable, packagedDistributionRoot } from "./aidlc-runtime-paths.ts";

export const PLUGIN_SCRIPT_PRELOAD = "aidlc-plugin-script-preload.ts";

export function pathContainedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

export type PluginScriptLaunch =
  | { ok: true; script: string; command: string; args: string[]; env: NodeJS.ProcessEnv }
  | {
    ok: false;
    // outside: the path leaves the tools folder; missing: no such file;
    // unresolved: its real path could not be read; real-outside: a link out.
    reason: "outside" | "missing" | "unresolved" | "real-outside";
    script: string;
    toolsDir: string;
    detail?: string;
  };

/**
 * The command that starts `file` (a path inside the project's harness tools
 * folder, such as `test-pro-doctor.ts`) for `plugin`, with AIDLC_PROJECT_DIR,
 * AIDLC_HARNESS_DIR and AIDLC_PLUGIN_NAME set; or why it cannot start.
 */
export function pluginScriptLaunch(options: {
  projectDir: string;
  harnessDir: string;
  plugin: string;
  file: string;
  env?: NodeJS.ProcessEnv;
}): PluginScriptLaunch {
  const toolsDir = resolve(options.projectDir, options.harnessDir, "tools");
  const script = resolve(toolsDir, options.file);
  if (!pathContainedBy(toolsDir, script)) return { ok: false, reason: "outside", script, toolsDir };
  if (!existsSync(script)) return { ok: false, reason: "missing", script, toolsDir };
  let realToolsDir: string;
  let realScript: string;
  try {
    realToolsDir = realpathSync(toolsDir);
    realScript = realpathSync(script);
  } catch (error) {
    return {
      ok: false,
      reason: "unresolved",
      script,
      toolsDir,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!pathContainedBy(realToolsDir, realScript)) return { ok: false, reason: "real-outside", script, toolsDir };
  const executable = compiledExecutable();
  const preload = executable ? nativePreload(options.harnessDir) : null;
  return {
    ok: true,
    script: realScript,
    command: executable ?? process.execPath,
    args: [...(preload ? ["--preload", preload] : []), realScript],
    env: {
      ...(options.env ?? process.env),
      ...(executable ? { BUN_BE_BUN: "1" } : {}),
      AIDLC_PROJECT_DIR: options.projectDir,
      AIDLC_HARNESS_DIR: options.harnessDir,
      AIDLC_PLUGIN_NAME: options.plugin,
    },
  };
}

function nativePreload(harnessDir: string): string | null {
  try {
    const path = join(packagedDistributionRoot(harnessDir), harnessDir, "tools", PLUGIN_SCRIPT_PRELOAD);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}
