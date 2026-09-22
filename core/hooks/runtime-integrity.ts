// Defense in depth for harness-owned runtime records and hooks, not a sandbox.
// Hooks and tool calls run as the same user, so an agent with unrestricted
// execution can always find a path around a lexical check. The outer boundary
// is the harness's permission model and the person's review of what the agent
// runs. This check runs before fence decisions; no Guard Policy word, lowered
// fence, or presence bypass turns it off.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ClaudeCodeHookInput } from "../tools/aidlc-lib.ts";
import { resolveHarnessRoot, runtimeHarnessDir } from "../tools/aidlc-runtime-paths.ts";
import {
  shellCommandInvocationDetails,
  shellWriteTargets,
  writeTargets,
} from "./review-freeze-command.ts";

const RUNTIME_RECORD_PATH = /(?:^|[\\/])\.(?:aidlc-sessions|aidlc-plan-approval)(?:[\\/]|$)/;
const RUNTIME_RECORD_MENTION = /(?:^|[\\/'"`\s])\.(?:aidlc-sessions|aidlc-plan-approval)(?=[\\/'"`\s]|$)/;
const HARNESS_HOOK_COMMAND = /(?:^|[\\/\s"'`])hooks[\\/]aidlc-[a-z-]+\.ts\b|\baidlc-(?:kiro|codex|copilot|cursor)-adapter\.ts\b|\baidlc(?:\.ts)?["']?\s+engine\s+hook\b/;
const HARNESS_CONTROL_ASSIGNMENT = /\b(?:AIDLC_SESSION_OVERRIDE|AIDLC_SESSION_OVERRIDE_SOURCE|AIDLC_SKIP_HUMAN_PRESENCE_GUARD|AIDLC_UNATTENDED|AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS|AIDLC_STATE_TRANSITION_OWNER)=/;
// A concrete import, require, or execution of a hook module: a hook file path
// or one of the two modules whose exports mint a human turn or apply intent
// settings, in an import/require/from with a string literal, an interpreter
// invocation of a hook file, or the engine hook command form. Applied to
// inline scripts, heredocs, aliases, functions, wrapper files, and written
// content alike: a comment, an inert string, or prose that merely names a
// hook or a helper is ordinary project content and stays runnable and
// writable.
const PROTECTED_MODULE_USE = new RegExp(
  String.raw`(?:\bimport\b[^\n;]*?|\brequire\s*\(\s*|\bfrom\s+)["'\x60][^"'\x60\n]*(?:hooks[\\/]aidlc-[a-z-]+|aidlc-(?:record-human-turn|guard-switch))(?:\.ts)?["'\x60]` +
  String.raw`|\b(?:bun|node|tsx|deno)\b[^\n;|&]*hooks[\\/]aidlc-[a-z-]+\.ts\b` +
  String.raw`|\baidlc(?:\.ts)?["']?\s+engine\s+hook\b`,
);
const SHELL_FUNCTION = /(?:^|[;\n|&])\s*(?:function\s+[\w-]+(?:\s*\(\s*\))?|[\w-]+\s*\(\s*\))\s*\{/;
const SCRIPT_EXTENSION = /\.(?:ts|js|mjs|cjs|sh|py)$/;
const MAX_SCRIPT_BYTES = 1024 * 1024;

export const RUNTIME_INTEGRITY_REFUSAL =
  "AIDLC runtime records and hooks belong to the harness: hooks write them when the person acts, and the engine reads them. " +
  "A tool call cannot invoke a hook, choose a session, set a bypass, or edit those records. Use the engine commands instead.";

function protectedRuntimePath(path: unknown, cwd: string): boolean {
  return typeof path === "string" && path.length > 0 && (
    RUNTIME_RECORD_PATH.test(path) || RUNTIME_RECORD_PATH.test(resolve(cwd, path))
  );
}

function pathWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function harnessInstallRoots(cwd: string): string[] {
  try {
    const harnessDir = runtimeHarnessDir(cwd);
    return [
      resolveHarnessRoot({ projectDir: cwd, harnessDir, mutable: true }),
      resolveHarnessRoot({ projectDir: cwd, harnessDir }),
    ];
  } catch {
    return [".claude", ".codex", ".kiro", ".cursor", ".aidlc"].map((dir) => resolve(cwd, dir));
  }
}

function protectedScriptFile(path: string, cwd: string): boolean {
  const absolute = resolve(cwd, path);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return false;
    // Shipped tools legitimately import hook helpers. Inspect model-authored
    // wrappers, not the runtime installation that those tools belong to.
    if (harnessInstallRoots(cwd).some((root) => pathWithin(absolute, root))) return false;
    return PROTECTED_MODULE_USE.test(readFileSync(absolute, "utf-8"));
  } catch {
    // An unreadable or missing script is outside this lexical check's reach.
    return false;
  }
}

function protectedContent(value: unknown): boolean {
  return typeof value === "string" && PROTECTED_MODULE_USE.test(value);
}

function protectedContentWrite(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
): boolean {
  const targets = writeTargets(toolName, toolInput, cwd);
  const contentTargets: string[] = [];
  if ([toolInput?.content, toolInput?.new_string, toolInput?.new_source].some(protectedContent)) {
    contentTargets.push(...targets);
  }
  if (Array.isArray(toolInput?.edits)) {
    for (const edit of toolInput.edits) {
      if (typeof edit !== "object" || edit === null || !protectedContent(edit.new_string)) continue;
      const editTargets = writeTargets(toolName, edit, cwd);
      contentTargets.push(...(editTargets.length > 0 ? editTargets : targets));
    }
  }
  if (contentTargets.length === 0) return false;
  const exemptRoots = harnessInstallRoots(cwd);
  // The authored repository must be able to develop and document its hooks.
  if (existsSync(resolve(cwd, "scripts/package.ts"))) {
    for (const tree of ["core", "harness", "tests", "docs"]) exemptRoots.push(resolve(cwd, tree));
  }
  return contentTargets.some((path) => {
    const absolute = resolve(cwd, path);
    return !exemptRoots.some((root) => pathWithin(absolute, root));
  });
}

function runtimeIntegrityViolation(input: ClaudeCodeHookInput): "runtime" | "content" | null {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (toolName === "Bash") {
    const command = toolInput?.command;
    if (typeof command !== "string") return null;
    if (
      HARNESS_HOOK_COMMAND.test(command) ||
      HARNESS_CONTROL_ASSIGNMENT.test(command)
    ) return "runtime";
    // The shared parser covers redirects, tee, cp destinations, mv sources
    // and destinations, rm, touch, and in-place sed writes.
    if (shellWriteTargets(command, cwd).some((path) => protectedRuntimePath(path, cwd))) {
      return "runtime";
    }
    let contentViolation = (command.includes("<<") || SHELL_FUNCTION.test(command)) &&
      PROTECTED_MODULE_USE.test(command);
    for (const { name, args, executable } of shellCommandInvocationDetails(command)) {
      if (name === "mkdir" && args.some((path) => protectedRuntimePath(path, cwd))) {
        return "runtime";
      }
      if (name === "alias" && args.some(protectedContent)) contentViolation = true;
      const python = /^python(?:\d+(?:\.\d+)*)?$/.test(name);
      const shell = /^(?:sh|bash|zsh)$/.test(name);
      const javascript = name === "node" || name === "bun" || name === "tsx";
      let inline = false;
      if (python || shell || javascript) {
        for (let index = 0; index < args.length; index++) {
          const arg = args[index];
          const shortFlag = javascript ? "-e" : "-c";
          const script = arg === shortFlag || (javascript && arg === "--eval") ||
              (shell && /^-[a-z]*c$/.test(arg))
            ? args[index + 1]
            : arg.startsWith(shortFlag)
              ? arg.slice(shortFlag.length)
              : javascript && arg.startsWith("--eval=")
                ? arg.slice("--eval=".length)
                : undefined;
          if (script === undefined) continue;
          inline = true;
          // Inline code can compute writes without a concrete shell target.
          if (RUNTIME_RECORD_MENTION.test(script)) return "runtime";
          if (PROTECTED_MODULE_USE.test(script)) contentViolation = true;
        }
      }
      if (contentViolation || inline) continue;
      let scriptPath: string | undefined;
      if (python || shell || javascript) {
        const index = args.findIndex((arg) => !arg.startsWith("-"));
        if (index >= 0) scriptPath = name === "bun" && args[index] === "run"
          ? args[index + 1]
          : args[index];
      } else if (executable && (executable.startsWith("./") || SCRIPT_EXTENSION.test(executable))) {
        scriptPath = executable;
      }
      if (scriptPath && protectedScriptFile(scriptPath, cwd)) contentViolation = true;
    }
    return contentViolation ? "content" : null;
  }
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) return null;
  if (writeTargets(toolName, toolInput, cwd).some((path) => protectedRuntimePath(path, cwd))) {
    return "runtime";
  }
  if (Array.isArray(toolInput?.edits) && toolInput.edits.some((edit: unknown) =>
    typeof edit === "object" && edit !== null && "file_path" in edit &&
    protectedRuntimePath(edit.file_path, cwd)
  )) return "runtime";
  return protectedContentWrite(toolName, toolInput, cwd) ? "content" : null;
}

export function violatesRuntimeIntegrity(input: ClaudeCodeHookInput): boolean {
  return runtimeIntegrityViolation(input) !== null;
}

/** Write the refusal for a violating tool call; true when the caller must exit 2. */
export function refuseRuntimeIntegrityViolation(input: ClaudeCodeHookInput): boolean {
  const violation = runtimeIntegrityViolation(input);
  if (violation === null) return false;
  const clause = violation === "content"
    ? " (Scripts the agent writes or runs may not import these hooks either.)"
    : "";
  process.stderr.write(`${RUNTIME_INTEGRITY_REFUSAL}${clause}\n`);
  return true;
}
