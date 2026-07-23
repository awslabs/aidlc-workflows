#!/usr/bin/env bun
// aidlc-copilot-adapter.ts — the GitHub Copilot (VS Code agent mode) hook shim
// (AUTHORED shell file; the aidlc-*.ts hook bodies beside it are PACKAGED core,
// byte-shared with the Claude Code harness). Modeled on the Codex adapter
// (harness/codex/hooks/aidlc-codex-adapter.ts) and the opencode plugin
// (harness/opencode/plugin/aidlc-opencode-adapter.ts): ONE shim normalizes the
// Copilot hook payload to the ClaudeCodeHookInput shape and subprocess-pipes
// into the named core hook, forwarding stdout/stderr/exit code.
//
// Copilot's hook contract is "near-isomorphic" to Claude Code's (research:
// generated/design/appendices/architecture-research/hook-adapter-lifecycle-*.md)
// with two load-bearing differences the shim reconciles:
//   1. Tool VOCABULARY. Copilot delivers its own tool names (runTerminalCommand,
//      editFiles, createFile, readFile, listDirectory, fileSearch, textSearch,
//      applyPatch); the core hooks key on Claude Code names (Bash, Edit, Write,
//      Read, LS, Glob, Grep). The shim maps every row of the §4.1 table before
//      dispatch (system-architecture.md §4.1).
//   2. tool_input KEY CASE. Copilot uses camelCase (filePath); the core hooks
//      read snake_case (file_path). The shim lowercases camelCase keys to
//      snake_case before delegating. `command` is identical in both.
//
// VS Code IGNORES hooks.json matcher values — every registered command fires on
// EVERY tool invocation regardless of matcher (research §5, "Difference from
// Claude Code hooks"). So the shim does the matcher's job IN CODE: each target
// gates dispatch by the normalized tool name and no-ops (exit 0) for tools the
// underlying core hook does not key on.
//
// Fail-open (ADR-002, security/implementation-guidance.md §1.1): a JSON.parse
// failure, an unknown/unmapped tool name, an out-of-project file_path, or a
// spawn failure all resolve to exit 0 (allow). The adapter NEVER exits 1 or
// throws — a broken shim must never trap a VS Code tool call. It only ever
// forwards a core hook's own exit 2 (a deliberate block) back to Copilot.
//
// Usage (wired in .github/hooks/hooks.json):
//   bun .github/hooks/aidlc-copilot-adapter.ts <target>
// where <target> ∈ session-start | user-prompt-submit | pre-tool-use |
//                  post-tool-use | pre-compact | subagent-stop | stop

import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface CopilotHookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  agent_type?: string;
  agent_id?: string;
  stop_hook_active?: boolean;
  reason?: string;
}

// --- Tool-name vocabulary map (system-architecture.md §4.1) -------------------
//
// Copilot native tool name → Claude Code equivalent the core hooks key on. An
// unmapped name is intentionally absent (→ undefined) so the caller fails open.
const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  runTerminalCommand: "Bash",
  editFiles: "Edit",
  createFile: "Write",
  readFile: "Read",
  listDirectory: "LS",
  fileSearch: "Glob",
  textSearch: "Grep",
  applyPatch: "Edit",
};

function normalizeToolName(copilotName: string): string | undefined {
  return TOOL_NAME_MAP[copilotName];
}

// camelCase → snake_case for a single key (filePath → file_path). Leaves an
// already-snake or single-word key untouched (command → command, path → path).
function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// Normalize every top-level tool_input key from Copilot's camelCase to the
// snake_case the core hooks read. A later canonical key wins over an earlier
// alias so an explicit file_path is never clobbered by a derived one.
function normalizeToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    const snake = camelToSnake(key);
    if (out[snake] === undefined || key === snake) out[snake] = value;
  }
  return out;
}

// --- Project dir + core-hook subprocess plumbing ------------------------------

function resolveProjectDir(cwdFromPayload: string | undefined): string {
  const raw = process.env.AIDLC_PROJECT_DIR ?? cwdFromPayload ?? process.cwd();
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

// Path confinement (RT-0002, security/implementation-guidance.md §1.1/§3): a
// forwarded file_path MUST resolve inside the project dir. An out-of-project
// path is rejected by SKIPPING dispatch (fail-open: VS Code still allows the
// tool call). Non-string / absent file_path is not path-shaped — allow.
function fileWithinProject(input: Record<string, unknown>, projectDir: string): boolean {
  const fp = input.file_path;
  if (typeof fp !== "string" || fp.length === 0) return true;
  const abs = isAbsolute(fp) ? resolve(fp) : resolve(projectDir, fp);
  return abs === projectDir || abs.startsWith(projectDir + sep);
}

interface CoreResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCore(hookFile: string, payload: unknown, projectDir: string): CoreResult {
  // Reuse the exact bun binary running this adapter; the child must not depend
  // on PATH containing bun (the hook environment often lacks the bun install
  // dir). A compiled single-file build routes via the embedded hook runner.
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  try {
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(input, "utf-8"),
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
  } catch {
    // ponytail: spawn failure fails open — a dead child must never block the
    // tool call (local trust boundary; ADR-002).
    return { stdout: "", stderr: "", code: 0 };
  }
}

// --- applyPatch envelope parsing (Copilot V4A diff) ---------------------------
//
// applyPatch carries the touched paths INSIDE the patch text (no file_path
// field), like Codex's apply_patch. Parse `*** Add|Update File:` lines and fan
// out one Edit per file for the PostToolUse audit surface (Delete skipped — the
// Claude harness never routes deletes through these hooks either). The patch
// text may live under any of the common field names.
function patchedFiles(input: Record<string, unknown>, projectDir: string): string[] {
  const patch =
    (typeof input.patch === "string" && input.patch) ||
    (typeof input.patch_text === "string" && input.patch_text) ||
    (typeof input.input === "string" && input.input) ||
    (typeof input.command === "string" && input.command) ||
    "";
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) {
    const rel = m[1].trim();
    if (rel.length > 0) out.push(isAbsolute(rel) ? rel : join(projectDir, rel));
  }
  return out;
}

// --- Main dispatch ------------------------------------------------------------

export async function run(target: string, rawInput: string): Promise<number> {
  let payload: CopilotHookInput = {};
  if (!process.stdin.isTTY) {
    try {
      if (rawInput.length > 0) payload = JSON.parse(rawInput) as CopilotHookInput;
    } catch {
      // ponytail: malformed stdin fails open (exit 0) — advisory boundary; a
      // parse failure must not block the tool call (ADR-002).
      return 0;
    }
  }

  const projectDir = resolveProjectDir(payload.cwd);
  const toolName = normalizeToolName(payload.tool_name ?? "");
  const toolInput = normalizeToolInput(payload.tool_input);

  switch (target) {
    case "session-start": {
      // SessionStart: inject AI-DLC workflow context. The core hook prints
      // {"additionalContext":"..."} which Copilot consumes directly; forward it
      // verbatim (system-architecture.md §Hook I/O Contract).
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: payload.source ?? "startup",
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd, projectDir);
      if (r.stdout) process.stdout.write(r.stdout);
      return 0;
    }

    case "user-prompt-submit": {
      // A real human acted this turn — mint a HUMAN_TURN presence event. The
      // core hook self-gates on workflow state and reads no stdin. Advisory.
      runCore("aidlc-mint-presence.ts", { hook_event_name: "UserPromptSubmit" }, projectDir);
      return 0;
    }

    case "pre-tool-use": {
      // Blocking gate. VS Code ignores matchers, so gate by tool name in code.
      //   Bash  → state-transition-guard THEN reviewer-scope (both may block)
      //   file/search tools → reviewer-scope only
      // Any core exit 2 is a deliberate block: forward exit 2 + stderr. An
      // unmapped tool falls through to exit 0 (fail-open).
      if (toolName === undefined) return 0; // ponytail: unmapped tool → allow
      if (!fileWithinProject(toolInput, projectDir)) return 0; // ponytail: out-of-project path → allow

      const preHooks: string[] =
        toolName === "Bash"
          ? ["aidlc-state-transition-guard.ts", "aidlc-reviewer-scope.ts"]
          : ["Read", "LS", "Glob", "Grep", "Edit", "Write"].includes(toolName)
            ? ["aidlc-reviewer-scope.ts"]
            : [];
      if (preHooks.length === 0) return 0;

      const fwd = {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
        ...(payload.agent_type ? { agent_type: payload.agent_type } : {}),
        ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
      };
      for (const hook of preHooks) {
        const r = runCore(hook, fwd, projectDir);
        if (r.code === 2) {
          if (r.stderr) process.stderr.write(r.stderr);
          return 2;
        }
      }
      return 0;
    }

    case "post-tool-use": {
      // Observability only — always exit 0 (PostToolUse is non-blocking).
      //   Edit/Write → audit-logger THEN sensor-fire (Claude registration order)
      //   Bash       → runtime-compile
      // applyPatch (→ Edit) has no file_path; fan out one audit+sensor pass per
      // file in the patch envelope.
      if (toolName === undefined) return 0; // ponytail: unmapped tool → allow

      if (payload.tool_name === "applyPatch") {
        for (const file of patchedFiles(toolInput, projectDir)) {
          const fwd = {
            hook_event_name: "PostToolUse",
            tool_name: "Edit",
            tool_input: { file_path: file },
          };
          runCore("aidlc-audit-logger.ts", fwd, projectDir);
          runCore("aidlc-sensor-fire.ts", fwd, projectDir);
        }
        return 0;
      }

      if (toolName === "Edit" || toolName === "Write") {
        if (!fileWithinProject(toolInput, projectDir)) return 0; // ponytail: out-of-project path → allow
        const fwd = {
          hook_event_name: "PostToolUse",
          tool_name: toolName,
          tool_input: toolInput,
        };
        runCore("aidlc-audit-logger.ts", fwd, projectDir);
        runCore("aidlc-sensor-fire.ts", fwd, projectDir);
        return 0;
      }

      if (toolName === "Bash") {
        runCore(
          "aidlc-runtime-compile.ts",
          {
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: toolInput,
          },
          projectDir,
        );
        return 0;
      }
      return 0;
    }

    case "pre-compact": {
      // PreCompact: state validation + recovery breadcrumb are self-contained
      // (the core hook reads no stdin fields). Advisory.
      runCore("aidlc-validate-state.ts", rawInput, projectDir);
      return 0;
    }

    case "subagent-stop": {
      // SubagentStop: log the completed subagent. Forward the identity fields.
      const fwd = JSON.stringify({
        hook_event_name: "SubagentStop",
        ...(payload.agent_type ? { agent_type: payload.agent_type } : {}),
        ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
      });
      runCore("aidlc-log-subagent.ts", fwd, projectDir);
      return 0;
    }

    case "stop": {
      // Stop: enforcement FIRST (aidlc-stop.ts may emit
      // {"decision":"block","reason":...} on stdout, exit 0 — forwarded
      // verbatim), THEN observability (aidlc-session-end.ts records
      // SESSION_ENDED). session-end never affects the stop decision.
      const enforce = runCore(
        "aidlc-stop.ts",
        JSON.stringify({
          hook_event_name: "Stop",
          stop_hook_active: payload.stop_hook_active ?? false,
        }),
        projectDir,
      );
      runCore(
        "aidlc-session-end.ts",
        JSON.stringify({ hook_event_name: "SessionEnd", reason: payload.reason ?? "stop" }),
        projectDir,
      );
      if (enforce.stdout) process.stdout.write(enforce.stdout);
      if (enforce.stderr) process.stderr.write(enforce.stderr);
      return enforce.code;
    }

    default:
      // ponytail: unknown target → allow (fail-open).
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text()));
}
