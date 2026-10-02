#!/usr/bin/env bun
// aidlc-antigravity-adapter.ts — Google Antigravity hook shim (AUTHORED shell file;
// the aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared across harnesses).
//
// Normalizes Antigravity tool and lifecycle hook payloads to ClaudeCodeHookInput
// and subprocess-pipes into the core hook implementations.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface AntigravityHookInput {
  hook_event_name?: string;
  event?: string;
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  agent_type?: string;
  agent_name?: string;
  agent_id?: string;
  prompt?: string;
  user_prompt?: string;
  message?: string;
  stop_hook_active?: boolean;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let payload: AntigravityHookInput = {};
  if (input.trim().length > 0) {
    try {
      payload = JSON.parse(input) as AntigravityHookInput;
    } catch {
      if (target !== "continue-workflow") return 0;
    }
  }

  const projectDirRaw =
    process.env.AIDLC_PROJECT_DIR ?? payload.cwd ?? process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);

  const sessionId =
    payload.session_id ?? payload.conversation_id ?? "antigravity-session";

  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    AIDLC_ANTIGRAVITY_SESSION_ID: sessionId,
  };

  function runCore(hookFile: string, stdinText: string): { stdout: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "engine", "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];

    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  function runCoreWithStderr(
    hookFile: string,
    stdinText: string,
  ): { stdout: string; stderr: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "engine", "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];

    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: projectEnv,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      code: r.exitCode ?? 0,
    };
  }

  const coreInput = JSON.stringify({
    session_id: sessionId,
    cwd: projectDir,
    tool_name: payload.tool_name ?? "",
    tool_input: payload.tool_input ?? {},
    tool_response: payload.tool_response ?? payload.tool_output,
    tool_use_id: payload.tool_use_id ?? "",
    agent_type: payload.agent_type ?? payload.agent_name,
    prompt: payload.prompt ?? payload.user_prompt ?? payload.message,
    stop_hook_active: payload.stop_hook_active,
  });

  switch (target) {
    case "session-start": {
      const res = runCore("aidlc-session-start.ts", coreInput);
      if (res.stdout.trim().length > 0) {
        process.stdout.write(res.stdout);
      }
      return 0;
    }
    case "record-human-turn": {
      runCore("aidlc-record-human-turn.ts", coreInput);
      return 0;
    }
    case "guard-tool-call":
    case "pre-tool": {
      const g1 = runCoreWithStderr("aidlc-state-transition-guard.ts", coreInput);
      if (g1.code !== 0) {
        process.stderr.write(g1.stderr);
        return g1.code;
      }
      const g2 = runCoreWithStderr("aidlc-reviewer-scope.ts", coreInput);
      if (g2.code !== 0) {
        process.stderr.write(g2.stderr);
        return g2.code;
      }
      const g3 = runCoreWithStderr("aidlc-plan-approval-guard.ts", coreInput);
      if (g3.code !== 0) {
        process.stderr.write(g3.stderr);
        return g3.code;
      }
      return 0;
    }
    case "post-tool":
    case "audit-and-sensors": {
      runCore("aidlc-audit-and-sensors.ts", coreInput);
      return 0;
    }
    case "validate-state": {
      runCore("aidlc-validate-state.ts", coreInput);
      return 0;
    }
    case "rebuild-stage-graph": {
      runCore("aidlc-rebuild-stage-graph.ts", coreInput);
      return 0;
    }
    case "log-subagent": {
      runCore("aidlc-log-subagent.ts", coreInput);
      return 0;
    }
    case "continue-workflow":
    case "stop": {
      const res = runCore("aidlc-continue-workflow.ts", coreInput);
      if (res.stdout.trim().length > 0) {
        process.stdout.write(res.stdout);
      }
      return res.code;
    }
    default:
      return 0;
  }
}

if (import.meta.main) {
  let stdinData = "";
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    stdinData = Buffer.concat(chunks).toString("utf-8");
  }

  const target = process.argv[2] ?? "";
  const code = await run(target, stdinData, process.argv.slice(3));
  process.exit(code);
}
