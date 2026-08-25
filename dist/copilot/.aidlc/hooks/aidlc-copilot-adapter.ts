#!/usr/bin/env bun
// aidlc-copilot-adapter.ts — the GitHub Copilot hook shim (AUTHORED shell
// file; the aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared
// with the Claude Code harness). Modeled on codex's aidlc-codex-adapter.ts:
// ONE shim normalizes the harness payload to the ClaudeCodeHookInput shape
// and subprocess-pipes into the named core hook, forwarding the result.
//
// ONE dist serves BOTH Copilot surfaces (CLI 1.0.74+ and VS Code agent mode
// 1.130+): the shipped .github/hooks/aidlc.json registers PascalCase event
// names. The CLI delivers mostly Claude-shaped snake_case payloads; VS Code
// uses its documented camelCase tool names/inputs plus snake_case agent ids.
// The adapter accepts both dialects. The
// load-bearing differences from Claude Code, all live-captured
// (captured by the compatibility spike):
//   1. File-tool input keys differ: Copilot sends `path` + `file_text` /
//      `old_str` / `new_str` where the core hooks read `file_path`. The shim
//      re-keys. Tool NAMES already match (Bash/Write/Edit/Read).
//   2. PreToolUse carries NO agent identity. SubagentStart/SubagentStop bracket
//      each delegation, so the shim keeps a locked per-project ledger keyed by
//      host session + subagent id. VS Code tool calls correlate through their
//      ordinary session_id; CLI toolu_* calls use an exactly-one-active CLI
//      fallback. Zero or several candidates forward no identity, so reviewer
//      scope fails open rather than mis-attributing the call.
//   3. SubagentStart arrives camelCase (agentName, sessionId — live-verified
//      quirk) while every other PascalCase-registered event arrives
//      snake_case. Field reads tolerate both casings.
//   4. The guard-tool-call BLOCK channel is stdout JSON, not exit-2/stderr: the core
//      guards answer exit 2 + reason on stderr, and the shim converts that
//      into {"hookSpecificOutput": {"hookEventName": "PreToolUse",
//      "permissionDecision": "deny", "permissionDecisionReason": ...}} — the
//      one deny dialect BOTH surfaces honor (live-verified on the CLI:
//      the call is refused and the reason is relayed to the model).
//   5. CLI SessionStart/Stop consume Claude-shaped top-level fields, while VS
//      Code requires the same fields inside hookSpecificOutput. The shim emits
//      both representations so one registration remains valid on both.
//   6. VS Code does not document SessionEnd, so the shared hook manifest omits
//      it on both hosts. The next SessionStart reconciles the prior session
//      (codex D-4 pattern) through the heartbeat file.
//   7. Custom-agent dispatches use the shared PreToolUse updatedInput contract:
//      the shim forwards the exact active-stage rule bundle rewrite and
//      converts an unloadable-rule exit 2 into the Copilot deny envelope.
//
// Wiring (.github/hooks/aidlc.json, emitted by harness/copilot/emit.ts) is
// matcher-FREE by design: VS Code parses but IGNORES matchers, so a matcher
// registered for the CLI would silently broaden on the IDE. Every target
// self-filters on tool_name instead.
//
// Usage: bun {{HARNESS_DIR}}/hooks/aidlc-copilot-adapter.ts <target>
// where <target> ∈ session-start | record-human-turn | guard-tool-call |
//                  post-tool | validate-state | subagent-start |
//                  log-subagent | continue-workflow

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  claimCopilotCommand,
  type CopilotCommandClaim,
  type CopilotDirectiveMetadata,
  recordCopilotHumanSequence,
  settleCopilotCommand,
  settleCopilotIntentBoundary,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ATTEMPT_FLAG = "--aidlc-attempt-id";

interface CopilotHookInput {
  hook_event_name?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_result?: unknown; toolResult?: unknown; tool_response?: unknown; toolResponse?: unknown;
  tool_use_id?: string; toolUseId?: string; tool_call_id?: string; toolCallId?: string;
  agent_name?: string;
  agentName?: string;
  agent_type?: string;
  agent_id?: string;
  agentId?: string;
  agent_display_name?: string;
  stop_reason?: string;
  stop_hook_active?: boolean;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let copilot: CopilotHookInput = {};
  if (input.length > 0) {
    try {
      copilot = JSON.parse(input) as CopilotHookInput;
    } catch {
      // Advisory and tool-guard hooks fail open. Stop is enforcement: its core
      // hook deliberately tolerates malformed stdin and still checks state.
      if (target !== "continue-workflow") return 0;
    }
  }

  const projectDirRaw = process.env.AIDLC_PROJECT_DIR ?? copilot.cwd ?? process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const sessionId = copilot.session_id ?? copilot.sessionId ?? "";
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    ...(sessionId ? { AIDLC_COPILOT_SESSION_ID: sessionId } : {}),
  };

  // Tolerant field reads: PascalCase-registered events arrive snake_case on
  // both surfaces EXCEPT SubagentStart, which the CLI delivers camelCase
  // (live-verified quirk #3 above).
  const subagentName =
    copilot.agent_type ?? copilot.agent_name ?? copilot.agentName ?? "";
  const explicitSubagentId = copilot.agent_id ?? copilot.agentId ?? "";
  const subagentId = explicitSubagentId || sessionId;
  const nativeToolInput = copilot.tool_input ?? copilot.toolInput;

  // Canonicalize the tool name across the two surfaces. The CLI sends
  // Claude-style names (Bash/Write/Edit/Read — live-captured); VS Code agent
  // mode uses its own snake_case execution ids (extracted from the shipped
  // extension's equivalence sets — parser-verified, pending a live IDE run).
  // Unknown names pass through unmapped and fall out of the self-filters,
  // exactly like any foreign tool.
  const TOOL_ALIAS: Record<string, string> = {
    // shell
    run_in_terminal: "Bash",
    runTerminalCommand: "Bash",
    bash: "Bash",
    local_shell: "Bash",
    // writes/creates
    create_file: "Write",
    createFile: "Write",
    create_directory: "Write",
    createDirectory: "Write",
    // edits
    apply_patch: "Edit",
    applyPatch: "Edit",
    editFiles: "Edit",
    insert_edit_into_file: "Edit",
    insertEditIntoFile: "Edit",
    replace_string_in_file: "Edit",
    replaceStringInFile: "Edit",
    multi_replace_string_in_file: "Edit",
    multiReplaceStringInFile: "Edit",
    edit_notebook_file: "Edit",
    editNotebookFile: "Edit",
    str_replace: "Edit",
    strReplace: "Edit",
    str_replace_editor: "Edit",
    // reads
    read_file: "Read",
    readFile: "Read",
    view: "Read",
    // read-scope sweep surfaces (VS Code names → core matcher arms)
    list_dir: "LS",
    listDir: "LS",
    listDirectory: "LS",
    file_search: "Glob",
    fileSearch: "Glob",
    glob: "Glob",
    grep_search: "Grep",
    grepSearch: "Grep",
    semantic_search: "Grep",
    semanticSearch: "Grep",
  };
  const rawToolName = copilot.tool_name ?? copilot.toolName ?? "";
  const toolName = TOOL_ALIAS[rawToolName] ?? rawToolName;
  const isApplyPatch = rawToolName === "apply_patch" || rawToolName === "applyPatch";

  // Re-serialize the payload with the canonical tool_name so verbatim pipes
  // (Bash → guards, rebuild-stage-graph) carry the name the core hooks match on.
  const canonicalInput = (() => {
    if (!rawToolName) return input;
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      parsed.tool_name = toolName;
      if (nativeToolInput) parsed.tool_input = nativeToolInput;
      const result = copilot.tool_result ?? copilot.toolResult;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const fields = result as Record<string, unknown>;
        parsed.tool_response = fields.text_result_for_llm ?? fields.textResultForLlm;
      } else if (copilot.tool_response ?? copilot.toolResponse) {
        parsed.tool_response = copilot.tool_response ?? copilot.toolResponse;
      }
      return JSON.stringify(parsed);
    } catch {
      return input;
    }
  })();

  // Machine-local per-user runtime state, beside the P8 session map — NOT the
  // per-intent health dir (the heartbeat outlives intents) and NOT the extinct
  // flat aidlc-docs/ root (the codex adapter's stale path — review P1-3).
  const heartbeatFile = join(
    projectDir,
    "aidlc",
    ".aidlc-sessions",
    "copilot-heartbeat.json",
  );

  // --- Core-hook subprocess plumbing -----------------------------------------

  function runCore(hookFile: string, stdin: string): { stdout: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdin, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  // Variant capturing stderr — the guard hooks' block channel (exit 2 + the
  // reason on stderr) must survive the pipe so it can be converted to the
  // Copilot deny JSON.
  function runCoreWithStderr(
    hookFile: string,
    stdin: string,
  ): { stdout: string; stderr: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdin, "utf-8"),
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

  // The one deny dialect both surfaces honor (difference #4). stdout JSON,
  // exit 0 — live-verified: the tool call is refused, the reason relayed.
  function denyJson(reason: string): string {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason.trim() || "Blocked by an AIDLC guard hook.",
      },
    })}\n`;
  }

  type ParsedOrchestration =
    | { status: "unrelated" | "unsupported" | "foreign" }
    | { status: "recognized"; claim: CopilotCommandClaim; rewrite: (attemptId: string) => string };

  function shellWords(command: string): string[] | null {
    const words: string[] = [];
    let word = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (escaped) { word += ch; escaped = false; continue; }
      if (ch === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) {
        if (ch === quote) quote = null;
        else if (
          (quote === '"' && ch === "`") ||
          (quote === '"' && ch === "$" && command[i + 1] === "(")
        ) return null;
        else word += ch;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (";&|<>`\n".includes(ch) || (ch === "$" && command[i + 1] === "(")) return null;
      else if (/\s/.test(ch)) { if (word) { words.push(word); word = ""; } }
      else word += ch;
    }
    if (escaped || quote) return null;
    if (word) words.push(word);
    return words;
  }

  function executionPrefix(command: string): string[] {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (";&|<>`\n".includes(ch) || (ch === "$" && command[i + 1] === "(")) {
        return shellWords(command.slice(0, i)) ?? [];
      }
    }
    return shellWords(command) ?? [];
  }

  function simpleCommand(command: string): {
    words: string[];
    body: string;
    redirect: string;
    expansionActive: boolean;
  } | null {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    let redirectStart = -1;
    let expansionActive = false;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) {
        if (ch === quote) quote = null;
        else if (
          (quote === '"' && ch === "`") ||
          (quote === '"' && ch === "$" && command[i + 1] === "(")
        ) return null;
        else if (quote === '"' && ch === "$") expansionActive = true;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "2" && (i === 0 || /\s/.test(command[i - 1])) && command.slice(i, i + 4) === "2>&1" &&
        command.slice(i + 4).trim().length === 0) {
        redirectStart = i;
        break;
      }
      if (";&|<>`\n".includes(ch) || (ch === "$" && command[i + 1] === "(")) return null;
      if (
        ch === "$" ||
        "*?[".includes(ch) ||
        (ch === "~" && (i === 0 || /\s/.test(command[i - 1])))
      ) {
        expansionActive = true;
      }
      if (ch === "{") {
        const end = command.indexOf("}", i + 1);
        if (end > i && /,|\.\./.test(command.slice(i + 1, end))) {
          expansionActive = true;
        }
      }
    }
    if (escaped || quote) return null;
    const body = command.slice(0, redirectStart < 0 ? command.length : redirectStart).trimEnd();
    const words = shellWords(body);
    return words
      ? {
          words,
          body,
          redirect: redirectStart < 0 ? "" : command.slice(redirectStart),
          expansionActive,
        }
      : null;
  }

  function safeAttemptId(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
  }

  function orchestrationCommand(): ParsedOrchestration {
    const command = nativeToolInput?.command;
    if (typeof command !== "string" || command.length === 0 || Buffer.byteLength(command) > 64 * 1024) return { status: "unrelated" };
    const prefix = executionPrefix(command);
    let prefixCursor = 0;
    const prefixFirst = prefix[prefixCursor++] ?? "";
    let directPrefix = false;
    if (prefixFirst === "bun" || prefixFirst === process.execPath) {
      if (prefix[prefixCursor] === "run") prefixCursor++;
      const script = prefix[prefixCursor] ?? "";
      const directPath = join(projectDir, ".aidlc", "tools", "aidlc-orchestrate.ts");
      const dispatcherPath = join(projectDir, ".aidlc", "tools", "aidlc.ts");
      try {
        const resolved = realpathSync(resolve(projectDir, script));
        directPrefix = resolved === realpathSync(directPath) || resolved === realpathSync(dispatcherPath);
      } catch {
        if (resolve(projectDir, script) === resolve(directPath) || resolve(projectDir, script) === resolve(dispatcherPath)) {
          return { status: "unsupported" };
        }
      }
    } else if (prefixFirst === "aidlc") {
      directPrefix = true;
    } else {
      const configured = process.env.AIDLC_COMPILED_EXECUTABLE;
      if (configured) {
        try { directPrefix = realpathSync(resolve(prefixFirst)) === realpathSync(resolve(configured)); }
        catch { directPrefix = resolve(prefixFirst) === resolve(configured) && prefixFirst.length > 0; }
      }
    }
    if (!directPrefix) return { status: "unrelated" };
    const parsed = simpleCommand(command);
    if (!parsed) return { status: "unsupported" };
    if (parsed.expansionActive) return { status: "unrelated" };
    const words = parsed.words;
    let cursor = 0;
    let args: string[];
    const first = words[cursor++] ?? "";
    if (first === "bun" || first === process.execPath) {
      if (words[cursor] === "run") cursor++;
      const script = words[cursor++] ?? "";
      let resolved = "", direct = "", dispatcher = "";
      try { resolved = realpathSync(resolve(projectDir, script)); direct = realpathSync(join(projectDir, ".aidlc", "tools", "aidlc-orchestrate.ts")); dispatcher = realpathSync(join(projectDir, ".aidlc", "tools", "aidlc.ts")); }
      catch { return { status: "unsupported" }; }
      if (resolved !== direct && resolved !== dispatcher) return { status: "unrelated" };
      args = words.slice(cursor);
    } else {
      const configured = process.env.AIDLC_COMPILED_EXECUTABLE;
      let compiled = first === "aidlc";
      if (!compiled && configured) {
        try { compiled = realpathSync(resolve(first)) === realpathSync(resolve(configured)); }
        catch { compiled = false; }
      }
      if (!compiled) return { status: "unrelated" };
      args = words.slice(cursor);
    }
    if (args[0] === "--resume") args = ["next", "--resume", ...args.slice(1)];
    const normalized: string[] = [];
    let attemptId = safeAttemptId(copilot.tool_use_id);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === ATTEMPT_FLAG) {
        const carried = args[++i];
        if (target === "guard-tool-call" || !safeAttemptId(carried) || (attemptId && attemptId !== carried)) return { status: "unsupported" };
        attemptId = carried;
        continue;
      }
      if (args[i] !== "--project-dir") { normalized.push(args[i]); continue; }
      const routed = args[++i];
      if (!routed) return { status: "unsupported" };
      try { if (realpathSync(resolve(projectDir, routed)) !== realpathSync(projectDir)) return { status: "foreign" }; }
      catch { return { status: "unsupported" }; }
    }
    const commandKind = normalized[0];
    if (!(["next", "continue", "report", "park"] as string[]).includes(commandKind)) return { status: "unrelated" };
    const subArgs = normalized.slice(1);
    if ((commandKind === "continue" && subArgs.length !== 1) || (commandKind === "park" && subArgs.length !== 0)) return { status: "unsupported" };
    const digest = createHash("sha256").update(JSON.stringify([commandKind, ...subArgs])).digest("hex");
    const flagValue = (name: string): string => subArgs[subArgs.lastIndexOf(name) + 1] ?? "";
    const reportResult = flagValue("--result");
    const skipRecovery = reportResult === "skipped" && subArgs.length === 6 && subArgs[0] === "--stage" && subArgs[2] === "--result" && subArgs[4] === "--reason" && flagValue("--reason") === "stage is SKIP in the approved workflow plan";
    return {
      status: "recognized",
      rewrite: (selectedAttemptId) => `${parsed.body} ${ATTEMPT_FLAG} ${selectedAttemptId}${parsed.redirect ? ` ${parsed.redirect}` : ""}`,
      claim: {
        sessionId,
        ...(attemptId ? { attemptId } : {}),
        commandKind: commandKind as CopilotCommandClaim["commandKind"],
        commandSha256: digest,
        ...(commandKind === "continue" ? { continueToken: subArgs[0] } : {}),
        ...(commandKind === "next" && subArgs.includes("--resume") ? { resumeRequest: true } : {}),
        ...(commandKind === "next" && (subArgs.includes("--stage") || subArgs.includes("--phase")) ? { jumpRequest: true } : {}),
        ...(commandKind === "next" && subArgs.includes("--new-intent") ? { startFreshRequest: true } : {}),
        ...(commandKind === "next" && subArgs.length === 0 ? { plainNext: true } : {}),
        ...(commandKind === "report" && skipRecovery ? { skipRecovery: true, reportStage: flagValue("--stage") } : {}),
      },
    };
  }

  function capturedDirective(): CopilotDirectiveMetadata | null {
    const result = copilot.tool_result ?? copilot.toolResult;
    const response = copilot.tool_response ?? copilot.toolResponse;
    let text: unknown;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const fields = result as Record<string, unknown>;
      if ((fields.result_type ?? fields.resultType) !== "success") return null;
      text = fields.text_result_for_llm ?? fields.textResultForLlm;
    } else if (typeof response === "string") {
      text = response;
    } else if (response && typeof response === "object" && !Array.isArray(response)) {
      const fields = response as Record<string, unknown>;
      if (fields.success === false || fields.tool_success === false) return null;
      text = fields.text_result_for_llm ?? fields.textResultForLlm ?? fields.text ?? fields.content ?? fields.output ?? fields.value;
    }
    if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024) return null;
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > 2 || lines.slice(1).some((line) => !/^<shellId:\s*[^>]*completed with exit code 0>$/.test(line.trim()))) return null;
    try {
      const value = JSON.parse(lines[0]?.trim() ?? "") as Record<string, unknown>;
      const kinds = new Set(["load-steering", "run-stage", "ask", "print", "error", "done", "parked", "dispatch-subagent", "invoke-swarm", "present-gate"]);
      if (!kinds.has(String(value.kind))) return null;
      const directive: CopilotDirectiveMetadata = {
        kind: value.kind as CopilotDirectiveMetadata["kind"],
        ...(typeof value.stage === "string" && /^[a-z][a-z0-9-]*$/.test(value.stage) ? { stage: value.stage } : {}),
        ...(typeof value.unit === "string" && Buffer.byteLength(value.unit) <= 4 * 1024 ? { unit: value.unit } : {}),
        ...(Number.isInteger(value.part) ? { part: value.part as number } : {}),
        ...(Number.isInteger(value.parts) ? { parts: value.parts as number } : {}),
        ...(typeof value.continue_token === "string" && Buffer.byteLength(value.continue_token) <= 16 * 1024 ? { continueToken: value.continue_token } : {}),
        resultSha256: createHash("sha256").update(lines[0] ?? "", "utf-8").digest("hex"),
      };
      if (directive.kind === "load-steering" && (!directive.stage || !directive.part || !directive.parts || directive.part > directive.parts || !directive.continueToken)) return null;
      if (directive.kind === "run-stage" && !directive.stage) return null;
      return directive;
    } catch { return null; }
  }

  function currentState(): string | null {
    const path = stateFilePath(projectDir);
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  const recoveryReason = "AI-DLC could not match this Copilot command to current coordination evidence. Run a fresh `bun .aidlc/tools/aidlc-orchestrate.ts next`; do not reuse an earlier continuation token.";

  // Re-key Copilot file-tool inputs (`path`/`file_path`/`filePath`, plus VS
  // Code's `files` lists) to the core hooks' `file_path` contract.
  //
  // The adapter is the trust boundary between the host and core hooks. Paths
  // outside the project are treated as absent: the tool call still fails open,
  // but no absolute host path crosses into audit, sensor, or guard hooks.
  const PROJECT_ROOT_LEXICAL = resolve(projectDir);
  const PROJECT_ROOT = (() => {
    try {
      return realpathSync(PROJECT_ROOT_LEXICAL);
    } catch {
      return null;
    }
  })();

  function confinedPath(raw: string): string | null {
    if (!PROJECT_ROOT) return null;
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(PROJECT_ROOT_LEXICAL, raw);
    const missingSegments: string[] = [];
    let cursor = candidate;
    let canonical: string | null = null;

    // Existing targets are resolved directly. For a prospective write, walk
    // to the nearest existing entry, resolve it, then append only the missing
    // lexical suffix. lstat detects broken links so they fail closed instead
    // of being mistaken for an ordinary missing path.
    while (true) {
      let exists = false;
      try {
        lstatSync(cursor);
        exists = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      }

      if (exists) {
        try {
          canonical = resolve(realpathSync(cursor), ...missingSegments);
        } catch {
          return null;
        }
        break;
      }

      const parent = dirname(cursor);
      if (parent === cursor) return null;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }

    const rel = relative(PROJECT_ROOT, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return canonical;
  }

  type MutationTarget = {
    filePath: string;
    toolName: "Write" | "Edit";
  };

  function applyPatchTargets(
    toolInput: Record<string, unknown>,
  ): Array<{ path: string; toolName: "Write" | "Edit" }> {
    const patch = [toolInput.input, toolInput.patchText, toolInput.patch, toolInput.command]
      .find((value): value is string => typeof value === "string" && value.length > 0) ?? "";
    const targets: Array<{ path: string; toolName: "Write" | "Edit" }> = [];
    for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
      targets.push({
        path: match[2].trim(),
        toolName: match[1] === "Add" ? "Write" : "Edit",
      });
    }
    for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      targets.push({ path: match[1].trim(), toolName: "Write" });
    }
    return targets.filter((target) => target.path.length > 0);
  }

  function filePathsOf(toolInput: Record<string, unknown> | undefined): string[] {
    if (!toolInput) return [];
    const rawPaths: string[] = [];
    const add = (value: unknown): void => {
      if (typeof value === "string" && value.length > 0) {
        rawPaths.push(value);
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const item = value as Record<string, unknown>;
      add(item.path);
      add(item.file_path);
      add(item.filePath);
    };
    add(toolInput.path);
    add(toolInput.file_path);
    add(toolInput.filePath);
    for (const key of ["files", "filePaths", "replacements"] as const) {
      const values = toolInput[key];
      if (Array.isArray(values)) {
        for (const value of values) add(value);
      }
    }
    return [...new Set(rawPaths.map(confinedPath).filter((p): p is string => p !== null))];
  }

  function mutationTargetsOf(
    toolInput: Record<string, unknown> | undefined,
    defaultToolName: "Write" | "Edit",
    parsePatchEnvelope = false,
  ): MutationTarget[] {
    if (!toolInput) return [];
    const rawTargets = parsePatchEnvelope
      ? applyPatchTargets(toolInput)
      : filePathsOf(toolInput).map((path) => ({
          path,
          toolName: defaultToolName,
        }));
    const targets = new Map<string, MutationTarget>();
    for (const rawTarget of rawTargets) {
      const filePath = parsePatchEnvelope
        ? confinedPath(rawTarget.path)
        : rawTarget.path;
      if (!filePath) continue;
      const existing = targets.get(filePath);
      if (!existing || (existing.toolName === "Edit" && rawTarget.toolName === "Write")) {
        targets.set(filePath, { filePath, toolName: rawTarget.toolName });
      }
    }
    return [...targets.values()];
  }

  function withoutPathFields(toolInput: Record<string, unknown>): Record<string, unknown> {
    const {
      path: _path,
      file_path: _filePath,
      filePath: _camelFilePath,
      files: _files,
      filePaths: _filePaths,
      replacements: _replacements,
      ...rest
    } = toolInput;
    return rest;
  }

  // --- Active-subagent ledger (difference #2) ---------------------------------
  //
  // VS Code carries a stable host session_id plus agent_id on SubagentStart /
  // Stop, while ordinary PreToolUse carries only that host session_id. CLI
  // lacks an explicit subagent id and identifies delegated tool calls with a
  // toolu_* session id, so it retains a separate exactly-one-active fallback.
  // Every entry is namespaced by host session plus subagent id; ambiguity
  // always fails open rather than mis-attributing a reviewer.
  const LEDGER = join(
    tmpdir(),
    `aidlc-copilot-subagents-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}.json`,
  );
  const LEDGER_LOCK = `${LEDGER}.lock`;
  const LEDGER_LOCK_OWNER = join(LEDGER_LOCK, "owner.json");
  const LEDGER_LOCK_STALE_MS = 30_000;

  interface LedgerEntry {
    hostSessionId: string;
    subagentId: string;
    name: string;
    hostCorrelated: boolean;
    ts: number;
  }

  interface LedgerLockOwner {
    pid: number;
    acquiredAt: number;
    token: string;
  }

  function readLedgerLockOwner(): LedgerLockOwner | null {
    try {
      const parsed = JSON.parse(readFileSync(LEDGER_LOCK_OWNER, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as LedgerLockOwner).pid !== "number" ||
        typeof (parsed as LedgerLockOwner).acquiredAt !== "number" ||
        typeof (parsed as LedgerLockOwner).token !== "string"
      ) {
        return null;
      }
      return parsed as LedgerLockOwner;
    } catch {
      return null;
    }
  }

  function reclaimStaleLedgerLock(): boolean {
    try {
      const owner = readLedgerLockOwner();
      const acquiredAt = owner?.acquiredAt ?? statSync(LEDGER_LOCK).mtimeMs;
      if (Date.now() - acquiredAt < LEDGER_LOCK_STALE_MS) return false;
      rmSync(LEDGER_LOCK, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  function acquireLedgerLock(): string | null {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        mkdirSync(LEDGER_LOCK);
        const owner: LedgerLockOwner = {
          pid: process.pid,
          acquiredAt: Date.now(),
          token: randomUUID(),
        };
        try {
          writeFileSync(LEDGER_LOCK_OWNER, JSON.stringify(owner), "utf-8");
          return owner.token;
        } catch {
          rmSync(LEDGER_LOCK, { recursive: true, force: true });
          return null;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
        if (reclaimStaleLedgerLock()) continue;
        Bun.sleepSync(10);
      }
    }
    return null;
  }

  function releaseLedgerLock(token: string): void {
    try {
      if (readLedgerLockOwner()?.token !== token) return;
      rmSync(LEDGER_LOCK, { recursive: true, force: true });
    } catch {
      // Identity correlation is best effort; never trap a host hook.
    }
  }

  function readLedgerUnlocked(): LedgerEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(LEDGER, "utf-8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      const cutoff = Date.now() - 30 * 60 * 1000;
      return parsed.filter(
        (entry): entry is LedgerEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.hostSessionId === "string" &&
          typeof entry.subagentId === "string" &&
          typeof entry.name === "string" &&
          typeof entry.hostCorrelated === "boolean" &&
          typeof entry.ts === "number" &&
          entry.ts >= cutoff,
      );
    } catch {
      return [];
    }
  }

  function writeLedgerUnlocked(entries: LedgerEntry[]): void {
    const temp = `${LEDGER}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(entries), "utf-8");
      renameSync(temp, LEDGER);
    } catch {
      // ledger is best-effort identity correlation — never block the turn
    } finally {
      try {
        rmSync(temp, { force: true });
      } catch {
        // rename already consumed the temp file in the normal path
      }
    }
  }

  function readLedger(): LedgerEntry[] {
    const lockToken = acquireLedgerLock();
    if (!lockToken) return [];
    try {
      return readLedgerUnlocked();
    } finally {
      releaseLedgerLock(lockToken);
    }
  }

  function updateLedger(update: (entries: LedgerEntry[]) => void): void {
    const lockToken = acquireLedgerLock();
    if (!lockToken) return;
    try {
      const entries = readLedgerUnlocked();
      update(entries);
      writeLedgerUnlocked(entries);
    } finally {
      releaseLedgerLock(lockToken);
    }
  }

  function activeSubagentCandidates(): LedgerEntry[] {
    const entries = readLedger();
    return sessionId.startsWith("toolu_")
      ? entries.filter((entry) => !entry.hostCorrelated)
      : entries.filter(
          (entry) => entry.hostCorrelated && entry.hostSessionId === sessionId,
        );
  }

  function activeSubagentType(): string | null {
    if (copilot.agent_type) return copilot.agent_type;
    const candidates = activeSubagentCandidates();
    return candidates.length === 1 ? candidates[0].name : null;
  }

  function delegatedAgentType(): string | null {
    if (copilot.agent_type) return copilot.agent_type;
    const candidates = activeSubagentCandidates();
    if (candidates.length === 1) return candidates[0].name;
    return candidates.length > 1 ? "aidlc-delegated-agent" : null;
  }

  // --- Targets ----------------------------------------------------------------

  switch (target) {
    case "session-start": {
      reconcilePriorSession();
      // Copilot delivers source "new" for a fresh session (live-captured);
      // the core hook's emission map knows startup|clear|resume|compact —
      // forward "new" as "startup" so SESSION_STARTED and the per-session
      // intent stamp (P8 rebind) fire. Other values pass through (resume is
      // shared vocabulary).
      const rawSource = copilot.source ?? "startup";
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: rawSource === "new" ? "startup" : rawSource,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      if (r.stdout) {
        try {
          const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
          const additionalContext = parsed.additionalContext;
          process.stdout.write(`${JSON.stringify({
            ...parsed,
            ...(typeof additionalContext === "string"
              ? {
                  hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext,
                  },
                }
              : {}),
          })}\n`);
        } catch {
          process.stdout.write(r.stdout);
        }
      }
      return 0;
    }

    case "record-human-turn": {
      // UserPromptSubmit: record HUMAN_TURN (human-presence gate). Same
      // self-gate as the core record-human-turn hook: no workflow state, no scaffolding.
      let stateContent: string;
      try {
        if (!existsSync(stateFilePath(projectDir))) return 0;
        stateContent = readFileSync(stateFilePath(projectDir), "utf-8");
      } catch {
        return 0;
      }
      try {
        appendAuditEntry("HUMAN_TURN", {}, projectDir);
      } catch {
        // best-effort presence record — advisory
      }
      if (sessionId) {
        try { recordCopilotHumanSequence(projectDir, stateContent, sessionId); }
        catch { /* bounded coordination remains best effort */ }
      }
      return 0;
    }

    case "guard-tool-call": {
      // ONE registration serves all matcher-free PreToolUse controls. Custom
      // agent dispatches first receive the exact active-stage rule bundle.
      // Copilot consumes the shared hookSpecificOutput.updatedInput envelope
      // directly, so no adapter-specific reshaping is needed.
      if (toolName.toLowerCase() === "agent") {
        const dispatch = runCoreWithStderr(
          "aidlc-deliver-stage-rules.ts",
          canonicalInput,
        );
        if (dispatch.code === 2) {
          process.stdout.write(denyJson(dispatch.stderr));
          return 0;
        }
        let dispatchInput = nativeToolInput ?? {};
        if (dispatch.stdout) {
          try {
            const updated = (
              JSON.parse(dispatch.stdout) as {
                hookSpecificOutput?: { updatedInput?: Record<string, unknown> };
              }
            ).hookSpecificOutput?.updatedInput;
            if (updated) dispatchInput = updated;
          } catch {
            // Malformed advisory output does not disable plan enforcement.
          }
        }
        const dispatchTarget = [
          dispatchInput.subagent_type,
          dispatchInput.agent_type,
          dispatchInput.agent,
          dispatchInput.role,
        ].find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )?.trim() ?? "";
        const planApproval = runCoreWithStderr(
          "aidlc-plan-approval-guard.ts",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_input: {
              ...dispatchInput,
              subagent_type: dispatchTarget,
            },
          }),
        );
        if (planApproval.code === 2) {
          process.stdout.write(denyJson(planApproval.stderr));
          return 0;
        }
        if (dispatch.stdout) process.stdout.write(dispatch.stdout);
        return 0;
      }

      // Shell calls run the state-transition guard first, then reviewer-scope.
      // Either block converts to the deny JSON (difference #4).
      if (toolName === "Bash") {
        const command = orchestrationCommand();
        if (command.status === "foreign") {
          process.stdout.write(denyJson("This AI-DLC command targets a different physical project. Run it from that project's own Copilot session."));
          return 0;
        }
        const guard = runCoreWithStderr(
          "aidlc-state-transition-guard.ts",
          withAgentType(canonicalInput, delegatedAgentType()),
        );
        if (guard.code === 2) {
          process.stdout.write(denyJson(guard.stderr));
          return 0;
        }
        const scope = runCoreWithStderr(
          "aidlc-reviewer-scope.ts",
          withAgentType(canonicalInput),
        );
        if (scope.code === 2) {
          process.stdout.write(denyJson(scope.stderr));
          return 0;
        }
        const freeze = runCoreWithStderr(
          "aidlc-review-freeze.ts",
          canonicalInput,
        );
        if (freeze.code === 2) {
          process.stdout.write(denyJson(freeze.stderr));
          return 0;
        }
        if (command.status === "unsupported") {
          process.stdout.write(denyJson("Use one simple direct, source-dispatcher, or compiled AI-DLC command without chaining, substitution, or redirection other than one terminal `2>&1`."));
          return 0;
        }
        if (command.status === "recognized") {
          if (!sessionId) return 0;
          let claimed: ReturnType<typeof claimCopilotCommand>;
          try { claimed = claimCopilotCommand(projectDir, currentState(), command.claim); }
          catch (error) {
            const reason = error instanceof Error &&
                error.name === "ActiveDirectiveLockContendedError"
              ? "AI-DLC coordination is busy and no claim was committed. Retry this exact command and the same continuation token, when present."
              : recoveryReason;
            process.stdout.write(denyJson(reason));
            return 0;
          }
          if (!claimed.allowed) {
            const reason = claimed.reason === "resume"
              ? "A legacy Resume marker is still waiting or selected. Re-run `next --resume` in the owning session to supersede it before continuing; bare `next` remains denied until then."
              : claimed.reason === "foreign"
                ? "This continuation belongs to another Copilot session. Run a fresh `next` in this session to take ownership; do not execute the owner's current token."
                : claimed.reason === "duplicate"
                  ? "An equivalent `continue` is already pending for this cursor. Retry after that invocation settles; this duplicate did not replace it."
                : claimed.reason === "state"
                  ? "The workflow state changed before this command could be claimed. Run a fresh `next`; do not reuse the previous continuation token."
                  : recoveryReason;
            process.stdout.write(denyJson(reason));
            return 0;
          }
          const modifiedArgs = { ...(nativeToolInput ?? {}), command: command.rewrite(claimed.attemptId) };
          process.stdout.write(`${JSON.stringify({ modifiedArgs, hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: modifiedArgs,
          } })}\n`);
        }
        return 0;
      }
      // The full read/edit sweep surface the core matcher enforces on Claude
      // (Read|Edit|Write plus LS/Glob/Grep — the sibling-sweep evasions).
      if (["Write", "Edit", "Read", "LS", "Glob", "Grep"].includes(toolName)) {
        const ti = nativeToolInput ?? {};
        const filePaths = filePathsOf(nativeToolInput);
        const mutationTargets =
          toolName === "Write" || toolName === "Edit"
            ? mutationTargetsOf(nativeToolInput, toolName, isApplyPatch)
            : [];
        // Path-shaped tools re-key `path` → `file_path`; the search tools
        // (LS/Glob/Grep) keep their native fields, which the core matcher
        // reads directly (path/pattern/glob).
        const toolCalls: Array<{
          toolName: string;
          toolInput: Record<string, unknown>;
        }> =
          toolName === "LS" || toolName === "Glob" || toolName === "Grep"
            ? [{
                toolName,
                toolInput: (() => {
                  const searchInput: Record<string, unknown> = {
                    ...withoutPathFields(ti),
                    ...(filePaths[0] ? { path: filePaths[0] } : {}),
                  };
                  if (
                    toolName === "Glob" &&
                    (rawToolName === "file_search" || rawToolName === "fileSearch") &&
                    typeof searchInput.query === "string"
                  ) {
                    const { query, ...rest } = searchInput;
                    return { ...rest, pattern: query };
                  }
                  return searchInput;
                })(),
              }]
            : toolName === "Write" || toolName === "Edit"
              ? mutationTargets.map((target) => ({
                  toolName: target.toolName,
                  toolInput: { file_path: target.filePath },
                }))
              : filePaths.map((filePath) => ({
                  toolName,
                  toolInput: { file_path: filePath },
                }));
        for (const call of toolCalls) {
          if (Object.keys(call.toolInput).length === 0) continue;
          const agentType = activeSubagentType();
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: call.toolName,
            tool_input: call.toolInput,
            ...(agentType ? { agent_type: agentType } : {}),
          });
          const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
          if (r.code === 2) {
            process.stdout.write(denyJson(r.stderr));
            return 0;
          }
        }
        for (const call of toolCalls) {
          if (call.toolName === "Write" || call.toolName === "Edit") {
            const freeze = runCoreWithStderr(
              "aidlc-review-freeze.ts",
              JSON.stringify({
                hook_event_name: "PreToolUse",
                tool_name: call.toolName,
                tool_input: call.toolInput,
              }),
            );
            if (freeze.code === 2) {
              process.stdout.write(denyJson(freeze.stderr));
              return 0;
            }
          }
        }
      }
      return 0;
    }

    case "post-tool": {
      // Matcher-free registration: self-filter on tool_name (the IDE ignores
      // matchers — difference in the wiring header). Advisory targets only.
      if (toolName === "Write" || toolName === "Edit") {
        for (
          const target of mutationTargetsOf(
            nativeToolInput,
            toolName,
            isApplyPatch,
          )
        ) {
          const fwd = JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: target.toolName,
            tool_input: { file_path: target.filePath },
          });
          runCore("aidlc-write-audit-log.ts", fwd);
          runCore("aidlc-run-sensors.ts", fwd);
        }
        return 0;
      }
      if (toolName === "Bash") {
        // The shell tool with tool_input.command — the core hook's exact
        // contract (canonicalized name for the IDE's run_in_terminal).
        runCore("aidlc-rebuild-stage-graph.ts", canonicalInput);
        const command = orchestrationCommand();
        if (command.status === "recognized" && sessionId) {
          try {
            settleCopilotCommand(projectDir, currentState(), command.claim, capturedDirective());
          } catch {
            // A fresh next is the bounded recovery for an unsettled result.
          }
        }
        if (sessionId) {
          try { settleCopilotIntentBoundary(projectDir, sessionId); } catch { /* bounded marker evidence */ }
        }
      }
      return 0;
    }

    case "validate-state": {
      // PreCompact: the core hook reads no stdin fields — self-contained.
      runCore("aidlc-validate-state.ts", input);
      return 0;
    }

    case "subagent-start": {
      if (subagentName) {
        const hostCorrelated = explicitSubagentId.length > 0;
        const ledgerSubagentId =
          explicitSubagentId || `cli-${process.pid}-${Date.now()}`;
        const entry: LedgerEntry = {
          hostSessionId: sessionId,
          subagentId: ledgerSubagentId,
          name: subagentName,
          hostCorrelated,
          ts: Date.now(),
        };
        updateLedger((entries) => {
          if (hostCorrelated) {
            const existing = entries.findIndex(
              (candidate) =>
                candidate.hostSessionId === sessionId &&
                candidate.subagentId === ledgerSubagentId,
            );
            if (existing >= 0) {
              entries[existing] = entry;
              return;
            }
          }
          entries.push(entry);
        });
      }
      return 0;
    }

    case "log-subagent": {
      // SubagentStop carries agent_name (+ display name); the core hook reads
      // agent_type/agent_id. Pop the ledger entry, then forward.
      if (subagentName) {
        updateLedger((entries) => {
          let idx = -1;
          if (explicitSubagentId) {
            idx = entries.findIndex(
              (entry) =>
                entry.hostCorrelated &&
                entry.hostSessionId === sessionId &&
                entry.subagentId === explicitSubagentId,
            );
          } else {
            for (let i = entries.length - 1; i >= 0; i--) {
              const entry = entries[i];
              if (
                !entry.hostCorrelated &&
                entry.hostSessionId === sessionId &&
                entry.name === subagentName
              ) {
                idx = i;
                break;
              }
            }
          }
          if (idx >= 0) entries.splice(idx, 1);
        });
      }
      runCore(
        "aidlc-log-subagent.ts",
        JSON.stringify({
          hook_event_name: "SubagentStop",
          agent_type: subagentName || "unknown",
          agent_id: subagentId,
        }),
      );
      return 0;
    }

    case "continue-workflow": {
      // Emit both host dialects: CLI reads the top-level Claude fields; VS Code
      // reads the same decision under hookSpecificOutput.
      let forwarded = input;
      try {
        const payload = JSON.parse(input) as Record<string, unknown>;
        delete payload.transcript_path;
        delete payload.transcriptPath;
        if (sessionId) payload.session_id = sessionId;
        forwarded = JSON.stringify(payload);
      } catch { /* malformed Stop remains core-owned */ }
      const r = runCore("aidlc-continue-workflow.ts", forwarded);
      if (r.stdout) {
        try {
          const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
          const decision = parsed.decision;
          const reason = parsed.reason;
          process.stdout.write(`${JSON.stringify({
            ...parsed,
            ...(typeof decision === "string"
              ? {
                  hookSpecificOutput: {
                    hookEventName: "Stop",
                    decision,
                    ...(typeof reason === "string" ? { reason } : {}),
                  },
                }
              : {}),
          })}\n`);
        } catch {
          process.stdout.write(r.stdout);
        }
      }
      return r.code;
    }

    default:
      return 0;
  }

  // Inject the correlated agent identity into a verbatim payload when the
  // ledger resolves one (Bash path — the file-tool path builds its own fwd).
  function withAgentType(
    raw: string,
    resolvedAgentType: string | null = activeSubagentType(),
  ): string {
    const agentType = resolvedAgentType;
    if (!agentType) return raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.agent_type = agentType;
      return JSON.stringify(parsed);
    } catch {
      return raw;
    }
  }

  // --- SESSION_ENDED reconcile-at-next-start (codex D-4 pattern) --------------
  // The shared Copilot manifest omits unsupported SessionEnd (difference #6).
  // The heartbeat file names the last live session; a session-start that finds
  // a DIFFERENT prior session emits inferred SESSION_ENDED through the
  // byte-shared core hook.
  function reconcilePriorSession(): void {
    // Only meaningful once the workspace shell exists (the aidlc/ root ships
    // with the install and is scaffolded on first /aidlc).
    if (!existsSync(join(projectDir, "aidlc"))) return;
    try {
      if (existsSync(heartbeatFile)) {
        const prior = JSON.parse(readFileSync(heartbeatFile, "utf-8")) as {
          session_id?: string;
          ts?: string;
        };
        if (prior.session_id && prior.session_id !== sessionId) {
          const reason =
            `inferred — the shared Copilot hook manifest omits unsupported ` +
            `SessionEnd; reconciled at next ` +
            `SessionStart. Prior session ${prior.session_id} last seen ${prior.ts ?? "unknown"}.`;
          runCore("aidlc-session-end.ts", JSON.stringify({ reason }));
        }
      }
      mkdirSync(dirname(heartbeatFile), { recursive: true });
      writeFileSync(
        heartbeatFile,
        JSON.stringify({ session_id: sessionId || "unknown", ts: new Date().toISOString() }),
        "utf-8",
      );
    } catch {
      // reconcile is observability — never block the session start
    }
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
