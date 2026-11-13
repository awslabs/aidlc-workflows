#!/usr/bin/env bun
// Antigravity hook adapter — translates Antigravity's `.agent/hooks.json`
// command hook payloads into the shared core hook scripts (`aidlc-*.ts`), and
// maps core hook verdicts back to Antigravity's native hook stdout schema.
//
// Antigravity hook events wired in `.agent/hooks.json`:
//   - SessionStart  -> `session-start`     (aidlc-session-start.ts)
//   - PreInvocation -> `mint`              (aidlc-record-human-turn.ts)
//   - PreToolUse    -> `guards`            (aidlc-state-transition-guard.ts,
//                                           aidlc-reviewer-scope.ts,
//                                           aidlc-review-freeze.ts,
//                                           aidlc-plan-approval-guard.ts,
//                                           aidlc-deliver-stage-rules.ts)
//   - PostToolUse   -> `audit-and-sensors` (aidlc-write-audit-log.ts,
//                                           aidlc-run-sensors.ts,
//                                           aidlc-log-subagent.ts)
//   - PostToolUse   -> `runtime-compile`   (aidlc-rebuild-stage-graph.ts)
//   - Stop          -> `stop`              (aidlc-continue-workflow.ts)

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = dirname(HOOKS_DIR);
const DEFAULT_PROJECT_DIR =
  basename(ENGINE_DIR) === ".agent" ? dirname(ENGINE_DIR) : ENGINE_DIR;

type JsonObject = Record<string, unknown>;

function asObject(v: unknown): JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonObject)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function resolveCwd(event: JsonObject): string {
  const direct = asString(event.cwd);
  if (direct && isAbsolute(direct)) return direct;
  const roots = event.workspacePaths ?? event.workspace_roots;
  if (Array.isArray(roots)) {
    for (const r of roots) {
      if (typeof r === "string" && r.length > 0) {
        return isAbsolute(r) ? r : resolve(DEFAULT_PROJECT_DIR, r);
      }
    }
  }
  if (direct) return resolve(DEFAULT_PROJECT_DIR, direct);
  const envDir =
    process.env.AIDLC_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    DEFAULT_PROJECT_DIR;
  return isAbsolute(envDir) ? envDir : resolve(DEFAULT_PROJECT_DIR, envDir);
}

export function resolveSessionId(event: JsonObject): string | undefined {
  return (
    asString(event.conversationId) ??
    asString(event.conversation_id) ??
    asString(event.session_id)
  );
}

export function normalizeToolName(rawName: string | undefined): string {
  switch (rawName) {
    case "run_command":
    case "Shell":
    case "Bash":
      return "Bash";
    case "write_file":
    case "Write":
      return "Write";
    case "edit_file":
    case "Edit":
    case "StrReplace":
      return "Edit";
    case "read_file":
    case "Read":
      return "Read";
    case "invoke_subagent":
    case "Task":
      return "Task";
    default:
      return rawName ?? "";
  }
}

export function normalizeToolInput(
  canonicalTool: string,
  rawArgs: JsonObject,
): JsonObject {
  if (canonicalTool === "Bash") {
    const command =
      asString(rawArgs.command) ??
      asString(rawArgs.CommandLine) ??
      asString(rawArgs.cmd) ??
      "";
    return { ...rawArgs, command };
  }
  if (canonicalTool === "Write") {
    const filePath =
      asString(rawArgs.file_path) ??
      asString(rawArgs.Path) ??
      asString(rawArgs.path) ??
      "";
    const content =
      typeof rawArgs.content === "string"
        ? rawArgs.content
        : typeof rawArgs.Content === "string"
        ? rawArgs.Content
        : "";
    return { ...rawArgs, file_path: filePath, content };
  }
  if (canonicalTool === "Edit") {
    const filePath =
      asString(rawArgs.file_path) ??
      asString(rawArgs.Path) ??
      asString(rawArgs.path) ??
      "";
    const oldString =
      typeof rawArgs.old_string === "string"
        ? rawArgs.old_string
        : typeof rawArgs.Target === "string"
        ? rawArgs.Target
        : "";
    const newString =
      typeof rawArgs.new_string === "string"
        ? rawArgs.new_string
        : typeof rawArgs.Replacement === "string"
        ? rawArgs.Replacement
        : "";
    return {
      ...rawArgs,
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
    };
  }
  if (canonicalTool === "Read") {
    const filePath =
      asString(rawArgs.file_path) ??
      asString(rawArgs.Path) ??
      asString(rawArgs.path) ??
      "";
    return { ...rawArgs, file_path: filePath };
  }
  if (canonicalTool === "Task") {
    const subagentType =
      asString(rawArgs.subagent_type) ??
      asString(rawArgs.TypeName) ??
      asString(rawArgs.agent) ??
      "";
    const description =
      asString(rawArgs.description) ?? asString(rawArgs.Role) ?? "";
    const prompt =
      asString(rawArgs.prompt) ?? asString(rawArgs.Prompt) ?? "";
    return {
      ...rawArgs,
      subagent_type: subagentType,
      description,
      prompt,
    };
  }
  return rawArgs;
}

export function buildClaudeInput(
  hookEventName: string,
  event: JsonObject,
): JsonObject {
  const cwd = resolveCwd(event);
  const sessionId = resolveSessionId(event);
  const transcriptPath =
    asString(event.transcriptPath) ?? asString(event.transcript_path);
  const toolCall = asObject(event.toolCall);
  const rawToolName =
    asString(toolCall.name) ?? asString(event.tool_name);
  const canonicalTool = normalizeToolName(rawToolName);
  const rawToolArgs = Object.keys(toolCall).length > 0
    ? asObject(toolCall.args)
    : asObject(event.tool_input);
  const toolInput = normalizeToolInput(canonicalTool, rawToolArgs);

  return {
    hook_event_name: hookEventName,
    cwd,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(canonicalTool ? { tool_name: canonicalTool, tool_input: toolInput } : {}),
    ...(event.toolResult !== undefined
      ? { tool_response: event.toolResult }
      : event.tool_output !== undefined
      ? { tool_response: event.tool_output }
      : {}),
  };
}

function injectSystemMessage(message: string): string {
  return JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: message,
        },
      },
    ],
  });
}

function runCoreWithStderr(
  hookFile: string,
  stdinText: string,
  projectDir: string,
): { stdout: string; stderr: string; code: number } {
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const hookName = hookFile.replace(/^aidlc-|\.ts$/g, "");
  const command = executable
    ? [executable, "engine", "hook", hookName]
    : [
        process.execPath,
        join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
        "engine",
        "hook",
        hookName,
      ];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(stdinText, "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: projectDir,
      CLAUDE_PROJECT_DIR: projectDir,
    },
  });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 0,
  };
}

export function dispatchSubcommand(
  subcommand: string,
  rawStdin: string,
): { stdout: string; exitCode: number } {
  let event: JsonObject = {};
  try {
    event = rawStdin.trim() ? asObject(JSON.parse(rawStdin)) : {};
  } catch {
    if (subcommand === "guards") {
      return {
        stdout: JSON.stringify({
          decision: "deny",
          reason:
            "AIDLC guard input was malformed; the operation was denied because its safety checks could not run.",
        }),
        exitCode: 0,
      };
    }
    return { stdout: "{}", exitCode: 0 };
  }

  const projectDir = resolveCwd(event);

  switch (subcommand) {
    case "session-start": {
      const input = {
        ...buildClaudeInput("SessionStart", event),
        source: asString(event.source) ?? "startup",
      };
      const out = runCoreWithStderr(
        "aidlc-session-start.ts",
        JSON.stringify(input),
        projectDir,
      ).stdout.trim();
      if (!out) return { stdout: "{}", exitCode: 0 };
      try {
        const parsed = asObject(JSON.parse(out));
        const hso = asObject(parsed.hookSpecificOutput);
        const ctx =
          asString(hso.additionalContext) ?? asString(parsed.additionalContext);
        if (ctx) return { stdout: injectSystemMessage(ctx), exitCode: 0 };
      } catch {
        return { stdout: injectSystemMessage(out), exitCode: 0 };
      }
      return { stdout: "{}", exitCode: 0 };
    }

    case "session-end": {
      const input = {
        ...buildClaudeInput("SessionEnd", event),
        reason: asString(event.reason) ?? "other",
      };
      runCoreWithStderr(
        "aidlc-session-end.ts",
        JSON.stringify(input),
        projectDir,
      );
      return { stdout: "{}", exitCode: 0 };
    }

    case "mint": {
      const input = {
        ...buildClaudeInput("UserPromptSubmit", event),
        prompt: (() => {
          const directPrompt =
            asString(event.prompt) ??
            asString(event.user_message) ??
            asString(event.message);
          if (directPrompt) return directPrompt;
          const tp =
            asString(event.transcriptPath) ?? asString(event.transcript_path);
          if (!tp) return "";
          try {
            const text = readFileSync(tp, "utf-8");
            const lines = text.trim().split(/\r?\n/);
            for (const line of lines.reverse()) {
              if (!line.trim()) continue;
              const record = JSON.parse(line) as JsonObject;
              if (
                record.type === "USER_INPUT" &&
                typeof record.content === "string"
              ) {
                const match =
                  /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(
                    record.content,
                  );
                return (match ? match[1] : record.content).trim();
              }
            }
          } catch {
            // Fall back to empty prompt if transcript cannot be read.
          }
          return "";
        })(),
      };
      runCoreWithStderr(
        "aidlc-record-human-turn.ts",
        JSON.stringify(input),
        projectDir,
      );
      return { stdout: "{}", exitCode: 0 };
    }

    case "guards": {
      const inputObj = buildClaudeInput("PreToolUse", event);
      const serialized = JSON.stringify(inputObj);
      const guardFiles = [
        "aidlc-state-transition-guard.ts",
        "aidlc-reviewer-scope.ts",
        "aidlc-review-freeze.ts",
        "aidlc-plan-approval-guard.ts",
      ];
      for (const file of guardFiles) {
        const res = runCoreWithStderr(file, serialized, projectDir);
        if (res.code !== 0) {
          const reason =
            res.code === 2
              ? res.stderr.trim() || "Blocked by AI-DLC guard."
              : `AIDLC guard ${file} failed with exit ${res.code}; the operation was denied because its safety checks could not complete.`;
          return {
            stdout: JSON.stringify({ decision: "deny", reason }),
            exitCode: 0,
          };
        }
        const trimmed = res.stdout.trim();
        if (!trimmed) continue;
        try {
          const parsed = asObject(JSON.parse(trimmed));
          const hso = asObject(parsed.hookSpecificOutput);
          const decision =
            asString(hso.permissionDecision) ?? asString(parsed.decision);
          const reason =
            asString(hso.permissionDecisionReason) ??
            asString(parsed.reason) ??
            "Blocked by AI-DLC guard.";
          if (decision === "deny" || decision === "block") {
            return {
              stdout: JSON.stringify({ decision: "deny", reason }),
              exitCode: 0,
            };
          }
        } catch {
          // Ignore non-JSON advisory output.
        }
      }
      if (inputObj.tool_name === "Task") {
        runCoreWithStderr(
          "aidlc-deliver-stage-rules.ts",
          serialized,
          projectDir,
        );
      }
      return {
        stdout: JSON.stringify({ decision: "allow" }),
        exitCode: 0,
      };
    }

    case "audit-and-sensors": {
      const inputObj = buildClaudeInput("PostToolUse", event);
      const serialized = JSON.stringify(inputObj);
      if (inputObj.tool_name === "Write" || inputObj.tool_name === "Edit") {
        runCoreWithStderr(
          "aidlc-write-audit-log.ts",
          serialized,
          projectDir,
        );
        runCoreWithStderr(
          "aidlc-run-sensors.ts",
          serialized,
          projectDir,
        );
      } else if (inputObj.tool_name === "Task") {
        const toolInput = asObject(inputObj.tool_input);
        const sub = asString(toolInput.subagent_type);
        const fwd = JSON.stringify({
          hook_event_name: "SubagentStop",
          ...(sub ? { agent_type: sub } : {}),
        });
        runCoreWithStderr("aidlc-log-subagent.ts", fwd, projectDir);
      }
      return { stdout: "{}", exitCode: 0 };
    }

    case "runtime-compile": {
      const inputObj = buildClaudeInput("PostToolUse", event);
      if (inputObj.tool_name === "Bash") {
        runCoreWithStderr(
          "aidlc-rebuild-stage-graph.ts",
          JSON.stringify(inputObj),
          projectDir,
        );
      }
      return { stdout: "{}", exitCode: 0 };
    }

    case "validate-state": {
      const inputObj = buildClaudeInput("PreCompact", event);
      runCoreWithStderr(
        "aidlc-validate-state.ts",
        JSON.stringify(inputObj),
        projectDir,
      );
      return { stdout: "{}", exitCode: 0 };
    }

    case "stop": {
      const inputObj = buildClaudeInput("Stop", event);
      const res = runCoreWithStderr(
        "aidlc-continue-workflow.ts",
        JSON.stringify(inputObj),
        projectDir,
      );
      const trimmed = res.stdout.trim();
      if (!trimmed) {
        return {
          stdout: JSON.stringify({ decision: "allow" }),
          exitCode: 0,
        };
      }
      try {
        const parsed = asObject(JSON.parse(trimmed));
        if (parsed.decision === "block") {
          const reason =
            asString(parsed.reason) ??
            "AI-DLC stage work is still in progress.";
          return {
            stdout: JSON.stringify({ decision: "continue", reason }),
            exitCode: 0,
          };
        }
      } catch {
        // Fall through to allow on unparseable output.
      }
      return {
        stdout: JSON.stringify({ decision: "allow" }),
        exitCode: 0,
      };
    }

    default:
      return { stdout: "{}", exitCode: 0 };
  }
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  const { stdout, exitCode } = dispatchSubcommand(target, input);
  if (stdout) process.stdout.write(`${stdout}\n`);
  return exitCode;
}

export function main(argv = process.argv.slice(2)): void {
  const subcommand = argv[0] ?? "";
  let rawStdin = "";
  try {
    rawStdin = readFileSync(0, "utf-8");
  } catch {
    rawStdin = "";
  }
  const { stdout, exitCode } = dispatchSubcommand(subcommand, rawStdin);
  if (stdout) process.stdout.write(`${stdout}\n`);
  process.exit(exitCode);
}

if (import.meta.main) {
  main();
}
