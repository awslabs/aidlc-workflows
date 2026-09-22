// The harness trust boundary for runtime records and hooks. Hooks write the
// session and Plan Approval records when the person acts; the engine reads
// them. A tool call issued by the model can therefore never invoke a hook,
// choose a session, set a bypass, or edit those records. This check runs first
// in the PreToolUse guards that see every shell and file-write tool call, on
// every harness, and it is not a fence: no Guard Policy word, lowered fence,
// or presence bypass turns it off.
import { resolve } from "node:path";
import type { ClaudeCodeHookInput } from "../tools/aidlc-lib.ts";
import {
  shellCommandInvocations,
  shellWriteTargets,
  writeTargets,
} from "./review-freeze-command.ts";

const RUNTIME_RECORD_PATH = /(?:^|[\\/])\.(?:aidlc-sessions|aidlc-plan-approval)(?:[\\/]|$)/;
const RUNTIME_RECORD_MENTION = /(?:^|[\\/'"`\s])\.(?:aidlc-sessions|aidlc-plan-approval)(?=[\\/'"`\s]|$)/;
const HARNESS_HOOK_COMMAND = /(?:^|[\\/\s"'`])hooks[\\/]aidlc-[a-z-]+\.ts\b|\baidlc-(?:kiro|codex|copilot|cursor)-adapter\.ts\b|\baidlc(?:\.ts)?["']?\s+engine\s+hook\b/;
const HARNESS_CONTROL_ASSIGNMENT = /\b(?:AIDLC_SESSION_OVERRIDE|AIDLC_SESSION_OVERRIDE_SOURCE|AIDLC_SKIP_HUMAN_PRESENCE_GUARD|AIDLC_UNATTENDED|AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS|AIDLC_STATE_TRANSITION_OWNER)=/;

export const RUNTIME_INTEGRITY_REFUSAL =
  "AIDLC runtime records and hooks belong to the harness: hooks write them when the person acts, and the engine reads them. " +
  "A tool call cannot invoke a hook, choose a session, set a bypass, or edit those records. Use the engine commands instead.";

function protectedRuntimePath(path: unknown, cwd: string): boolean {
  return typeof path === "string" && path.length > 0 && (
    RUNTIME_RECORD_PATH.test(path) || RUNTIME_RECORD_PATH.test(resolve(cwd, path))
  );
}

export function violatesRuntimeIntegrity(input: ClaudeCodeHookInput): boolean {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (toolName === "Bash") {
    const command = toolInput?.command;
    if (typeof command !== "string") return false;
    if (
      HARNESS_HOOK_COMMAND.test(command) ||
      HARNESS_CONTROL_ASSIGNMENT.test(command)
    ) return true;
    // The shared parser covers redirects, tee, cp destinations, mv sources
    // and destinations, rm, touch, and in-place sed writes.
    if (shellWriteTargets(command, cwd).some((path) => protectedRuntimePath(path, cwd))) {
      return true;
    }
    for (const { name, args } of shellCommandInvocations(command)) {
      if (name === "mkdir" && args.some((path) => protectedRuntimePath(path, cwd))) {
        return true;
      }
      const python = /^python(?:\d+(?:\.\d+)*)?$/.test(name);
      if (!python && name !== "node" && name !== "bun") continue;
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const shortFlag = python ? "-c" : "-e";
        const script = arg === shortFlag || (!python && arg === "--eval")
          ? args[index + 1]
          : arg.startsWith(shortFlag)
            ? arg.slice(shortFlag.length)
            : !python && arg.startsWith("--eval=")
              ? arg.slice("--eval=".length)
              : undefined;
        // Inline code can compute writes that have no concrete shell target.
        // Naming a protected directory in such a script is enough to refuse.
        if (script && RUNTIME_RECORD_MENTION.test(script)) return true;
      }
    }
    return false;
  }
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) return false;
  if (writeTargets(toolName, toolInput, cwd).some((path) => protectedRuntimePath(path, cwd))) {
    return true;
  }
  if (Array.isArray(toolInput?.edits)) {
    return toolInput.edits.some((edit: unknown) =>
      typeof edit === "object" && edit !== null && "file_path" in edit &&
      protectedRuntimePath(edit.file_path, cwd)
    );
  }
  return false;
}

/** Write the refusal for a violating tool call; true when the caller must exit 2. */
export function refuseRuntimeIntegrityViolation(input: ClaudeCodeHookInput): boolean {
  if (!violatesRuntimeIntegrity(input)) return false;
  process.stderr.write(`${RUNTIME_INTEGRITY_REFUSAL}\n`);
  return true;
}
