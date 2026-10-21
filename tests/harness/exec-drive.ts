// Headless CLI project setup and invocation helpers shared by live e2e tests
// and plugin tests. These preserve the command lines and scratch-project
// shapes proven by the harness-specific status journeys.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";
import { STOP_HOOK_PROBE_ENV } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codexExecTimeout, codexPersonTurn, recordCodexExec } from "./codex-test-lifecycle.ts";
import { turnEvidence } from "./codex-turn-evidence.ts";
import { type AgentWords, keepAgentWords, keepLegAudit } from "./leg-evidence.ts";
import type { CapturedToolResult } from "./sdk-drive.ts";
import { LIVE_LONG_OPERATION_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const COPILOT_DIST = join(REPO_ROOT, "dist", "copilot");
const OPENCODE_DIST = join(REPO_ROOT, "dist", "opencode");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor");

const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const COPILOT_BIN = process.env.AIDLC_COPILOT_BIN ?? "copilot";
const OPENCODE_BIN = process.env.AIDLC_OPENCODE_BIN ?? "opencode";
const CURSOR_BIN = process.env.AIDLC_CURSOR_BIN ?? "agent";

const OPENCODE_MODEL =
  process.env.AIDLC_OPENCODE_MODEL ??
  `amazon-bedrock/${CI_BEDROCK_MODELS.opencode}`;
// "auto" is the one model every Cursor plan can use (Free rejects all named
// models with rc 0). Override for repeatable named-model runs.
const CURSOR_MODEL = process.env.AIDLC_CURSOR_MODEL ?? "auto";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : LIVE_LONG_OPERATION_TIMEOUT_MS / 1000) * 1000;

function initializeGit(projectDir: string): void {
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "install"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "exec fixture git" }),
    });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
  }
}

export interface CodexProject {
  proj: string;
  home: string;
  root: string;
}

/** Select the native sandbox for fresh Windows homes without changing its permissions. */
export function codexWindowsSandboxConfig(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "win32" ? ["", "[windows]", 'sandbox = "elevated"'] : [];
}

/** Route every scratch Codex home through the CI broker when one is configured. */
export function codexBedrockEndpointConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.AIDLC_BROKER_URL) return [];
  const url = new URL(env.AIDLC_BROKER_URL);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Expected a loopback Codex credential broker");
  }
  return [
    "[model_providers.amazon-bedrock]",
    `base_url = ${JSON.stringify(`${url.origin}/openai/v1`)}`,
    "",
  ];
}

/** Leave credentials to the SDK default chain unless the caller selects a profile. */
export function codexBedrockConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.AIDLC_CODEX_AWS_PROFILE;
  return [
    ...codexBedrockEndpointConfig(env),
    "[model_providers.amazon-bedrock.aws]",
    ...(profile ? [`profile = ${JSON.stringify(profile)}`] : []),
    `region = ${JSON.stringify(env.AIDLC_CODEX_AWS_REGION ?? "us-east-2")}`,
  ];
}

// A scratch install: dist/codex copied verbatim, git-initialized (project
// hooks.json discovery requires a git repo), a scratch CODEX_HOME with Bedrock
// provider + project trust + the trust pre-seed from `package.ts codex trust`
// so hooks fire with zero TUI passes. A journey that writes workflow records
// asks for the workspace-write sandbox.
export function setupCodexProject(opts: { workspaceWrite?: boolean } = {}): CodexProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-exec-")));
  const proj = join(root, "proj");
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  cpSync(join(CODEX_DIST, ".codex"), join(proj, ".codex"), {
    recursive: true,
  });
  cpSync(join(CODEX_DIST, ".agents"), join(proj, ".agents"), {
    recursive: true,
  });
  cpSync(join(CODEX_DIST, "AGENTS.md"), join(proj, "AGENTS.md"));
  initializeGit(proj);
  const trust = spawnSync(
    "bun",
    [
      join(REPO_ROOT, "scripts", "package.ts"),
      "codex",
      "trust",
      "--project",
      proj,
    ],
    { encoding: "utf-8", cwd: REPO_ROOT,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "Codex fixture trust" }) },
  );
  if (trust.status !== 0) {
    throw new Error(`trust emit failed: ${trust.stderr}`);
  }
  writeFileSync(
    join(home, "config.toml"),
    [
      `model = ${JSON.stringify(CI_BEDROCK_MODELS.codex)}`,
      `model_provider = "amazon-bedrock"`,
      `model_context_window = 1000000`,
      `model_reasoning_effort = "low"`,
      // No update check on start: a live run must not change the tool it measures (a root setting, as below).
      `check_for_update_on_startup = false`,
      // A root setting: after the first table it would belong to that table.
      ...(opts.workspaceWrite ? [`sandbox_mode = "workspace-write"`] : []),
      ``,
      ...codexBedrockConfig(),
      ``,
      `[shell_environment_policy]`,
      `exclude = ["AWS_*", "AIDLC_BROKER_*", "ANTHROPIC_*", "KIRO_API_KEY", "CURSOR_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_*"]`,
      ``,
      `[projects.${JSON.stringify(proj)}]`,
      `trust_level = "trusted"`,
      ``,
      trust.stdout,
      ...codexWindowsSandboxConfig(),
    ].join("\n"),
    "utf-8",
  );
  return { proj, home, root };
}

export interface ExecResult {
  rc: number;
  out: string;
}

/** Exec cannot service interactive request_user_input RPCs. The shipped skill
 * has a prose approval fallback; keep that gate available in headless tests. */
export function codexHeadlessArgs(...args: string[]): string[] {
  return ["-c", "features.default_mode_request_user_input=false", ...args];
}

/** The argv of one headless `codex exec` turn for `prompt`. The "--" ends codex exec's own options, so a line that
 * is one of its subcommand words (`help`, `resume`) or starts with a dash is still the prompt, never an argument. */
export function codexExecArgs(prompt: string): string[] {
  return codexHeadlessArgs("exec", "--", prompt);
}

/** The argv of a headless `codex exec resume --last` turn: the newest session under CODEX_HOME (a scratch home holds
 * the one this run opened) continues with `prompt`. codex exec takes the lone positional after --last as the prompt,
 * and the "--" keeps a dash-led line out of its options, as in `codexExecArgs`. */
export function codexResumeArgs(prompt: string): string[] {
  return codexHeadlessArgs("exec", "resume", "--last", "--", prompt);
}

function runCodex(proj: string, home: string, argv: string[], prompt: string): ExecResult {
  const turn = codexPersonTurn(proj, prompt);
  const result = spawnSync(CODEX_BIN, argv, {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: codexExecTimeout(TEST_TIMEOUT_MS),
  });
  const captured = {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
    signal: result.signal,
    error: result.error?.message,
  };
  recordCodexExec("status", proj, [CODEX_BIN, ...argv], captured, turn);
  return captured;
}

export function execCodex(
  proj: string,
  home: string,
  prompt: string,
): ExecResult {
  return runCodex(proj, home, codexExecArgs(prompt), prompt);
}

/** The person's next turn in the session `execCodex` opened under the same scratch `home`, recorded like the first. */
export function execCodexResume(proj: string, home: string, prompt: string): ExecResult {
  return runCodex(proj, home, codexResumeArgs(prompt), prompt);
}

const ENGINE_STEP = /engine orchestrate|aidlc-orchestrate\.ts/;

/** The shell commands of one `codex exec --json` turn, in the shape the SDK drive captures tool calls. */
export function codexToolResults(stdout: string): CapturedToolResult[] {
  const results: CapturedToolResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; item?: { id?: unknown; type?: unknown; command?: unknown; aggregated_output?: unknown; exit_code?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item;
    if (event.type !== "item.completed" || item?.type !== "command_execution") continue;
    results.push({
      toolName: "Bash", input: { command: String(item.command ?? "") }, toolUseId: String(item.id ?? ""),
      resultText: String(item.aggregated_output ?? ""), isError: item.exit_code !== 0,
    });
  }
  return results;
}

/** What Codex told the person in one `codex exec --json` turn: its finished agent messages. */
export function codexReplies(stdout: string): AgentWords[] {
  const replies: AgentWords[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; item?: { type?: unknown; text?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = event.item?.text;
    if (event.type !== "item.completed" || event.item?.type !== "agent_message" || typeof text !== "string" || !text.trim()) continue;
    replies.push({ text });
  }
  return replies;
}

export interface CodexJsonTurn extends ExecResult {
  stdout: string;
  sessionId?: string;
  results: CapturedToolResult[];
}

/**
 * One person turn as `codex exec --json`: a new session, or `sessionId`
 * resumed. Recorded like every live exec (recordCodexExec: a decision no turn
 * backs, or the sandbox refusing AI-DLC's own command, fails it). Codex can
 * keep a finished command's output as empty (a nightly saw it); when the turn's last
 * engine step came back empty, the engine's read-only Stop-hook probe says what
 * it hands out now, and that stands in for it.
 */
export function codexJsonTurn(proj: string, home: string, prompt: string, label: string, sessionId?: string): CodexJsonTurn {
  const argv = codexHeadlessArgs(...(sessionId ? ["exec", "resume", "--json", sessionId, prompt] : ["exec", "--json", prompt]));
  const turn = codexPersonTurn(proj, prompt);
  const r = spawnSync(CODEX_BIN, argv, {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: codexExecTimeout(TEST_TIMEOUT_MS),
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  const result = {
    rc: r.status ?? -1, stdout, out: `${stdout}\n${r.stderr ?? ""}\n${r.error?.message ?? ""}`, signal: r.signal, error: r.error?.message,
  };
  recordCodexExec(label, proj, [CODEX_BIN, ...argv], result, turn);
  const results = codexToolResults(stdout);
  const last = results.findLast((t) => ENGINE_STEP.test(String(t.input.command)));
  if (last && !last.isError && last.resultText === "") {
    const probe = spawnSync("bun", [join(".codex", "tools", "aidlc.ts"), "engine", "orchestrate", "next", "--resume"], {
      cwd: proj, encoding: "utf-8", env: { ...process.env, CODEX_HOME: home, [STOP_HOOK_PROBE_ENV]: "1" },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "Codex engine probe" }),
    });
    if (probe.status === 0) {
      results.push({
        toolName: "Bash", input: { command: "engine orchestrate next --resume (read-only probe for an empty capture)" },
        toolUseId: "probe", resultText: probe.stdout ?? "", isError: false,
      });
    }
  }
  return { ...result, results, ...(result.rc === 0 ? { sessionId: turnEvidence(stdout).sessionId } : {}) };
}

// A scratch install: dist/copilot copied verbatim (dotfiles included: the
// engine at .aidlc/, the shell at .github/), then git-initialized (Copilot
// resolves repo context from the git root).
export function setupCopilotProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "copilot-exec-")));
  const proj = join(root, "proj");
  cpSync(COPILOT_DIST, proj, { recursive: true });
  initializeGit(proj);
  return proj;
}

// The /aidlc text rides the prompt (slash-skill invocation); --allow-all-tools
// lets the engine's read-only bun calls run unprompted in -p mode. --no-remote
// keeps the session off GitHub's session sync.
export function runCopilot(proj: string, args: string): ExecResult {
  const result = spawnSync(
    COPILOT_BIN,
    ["-p", `/aidlc ${args}`, "-s", "--no-remote", "--allow-all-tools"],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: remainingOperationTimeoutMs(TEST_TIMEOUT_MS, { phase: "Copilot exec" }),
    },
  );
  keepAgentWords("copilot", copilotReplies(result.stdout ?? "", false));
  keepLegAudit(proj);
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

/** A person's Copilot home (COPILOT_HOME) that trusts `proj`, as Copilot's own trust dialog records it. */
export function trustCopilotFolder(copilotHome: string, proj: string): void {
  mkdirSync(copilotHome, { recursive: true });
  writeFileSync(join(copilotHome, "config.json"), `${JSON.stringify({ trustedFolders: [proj] }, null, 2)}\n`);
}

export interface CopilotTurnOptions {
  /** The person's Copilot home: their folder trust and the session record. */
  copilotHome: string;
  /** The session the test names; the first turn opens it, later turns resume it. */
  sessionId: string;
  resume: boolean;
  /** Where Copilot writes the session's token usage. */
  usageFile?: string;
  timeoutMs?: number;
  /** Print the turn as JSON events (one per line), which `copilotToolResults` reads. */
  json?: boolean;
  /**
   * Hand the line over on stdin, not as `-p <line>`: no shell or launcher sees
   * it, so it arrives as typed. On Windows the CLI is an npm `.cmd` launcher,
   * and Bun refuses an argument with a double quote for one.
   */
  stdin?: boolean;
}

/** The argv and stdin of one Copilot CLI turn for `line`. */
export function copilotTurnCommand(line: string, options: CopilotTurnOptions): { argv: string[]; input?: string } {
  return {
    argv: [
      ...(options.stdin ? [] : ["-p", line]), "-s", "--no-remote", "--allow-all-tools",
      ...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
      ...(options.usageFile ? ["--usage-output-file", options.usageFile] : []),
      ...(options.json ? ["--output-format", "json"] : []),
    ],
    ...(options.stdin ? { input: line } : {}),
  };
}

// One person turn in a named Copilot CLI session: the typed line rides the
// prompt as it is (`/aidlc ...` or a reply), so AI-DLC's hooks see what the
// person typed. --allow-all-tools as in runCopilot.
export function copilotTurn(proj: string, line: string, options: CopilotTurnOptions): ExecResult {
  const { argv, input } = copilotTurnCommand(line, options);
  const result = spawnSync(
    COPILOT_BIN,
    argv,
    {
      cwd: proj,
      encoding: "utf-8",
      ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
      env: { ...process.env, PWD: proj, COPILOT_HOME: options.copilotHome },
      timeout: remainingOperationTimeoutMs(options.timeoutMs ?? TEST_TIMEOUT_MS, { phase: "Copilot turn" }),
      // A JSON turn prints an event per streamed token: several MB for one stage.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  keepAgentWords("copilot", copilotReplies(result.stdout ?? "", options.json === true));
  keepLegAudit(proj);
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
}

/** What Copilot told the person in one turn: the lead's finished messages of a JSON turn, or the printed reply. */
export function copilotReplies(stdout: string, json: boolean): AgentWords[] {
  if (!json) return stdout.trim() ? [{ text: stdout.trim() }] : [];
  const replies: AgentWords[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; timestamp?: unknown; data?: { content?: unknown; parentToolCallId?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event.data?.content;
    if (event.type !== "assistant.message" || event.data?.parentToolCallId || typeof content !== "string" || !content.trim()) continue;
    replies.push({ ...(typeof event.timestamp === "string" ? { ts: event.timestamp } : {}), text: content });
  }
  return replies;
}

/**
 * The shell commands of one `copilot --output-format json` turn (its `bash`
 * tool, `powershell` on Windows), in the shape the SDK drive captures tool calls.
 */
export function copilotToolResults(stdout: string): CapturedToolResult[] {
  const commands = new Map<string, string>();
  const results: CapturedToolResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; data?: { toolCallId?: unknown; arguments?: { command?: unknown }; success?: unknown; result?: { content?: unknown } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const id = String(event.data?.toolCallId ?? "");
    if (event.type === "tool.execution_start" && typeof event.data?.arguments?.command === "string") {
      commands.set(id, event.data.arguments.command);
    } else if (event.type === "tool.execution_complete" && commands.has(id)) {
      results.push({
        toolName: "Bash", input: { command: commands.get(id)! }, toolUseId: id,
        resultText: String(event.data?.result?.content ?? ""), isError: event.data?.success === false,
      });
    }
  }
  return results;
}

export interface OpencodeProject {
  proj: string;
  root: string;
}

// A scratch install: dist/opencode copied verbatim (dotfiles included: the
// engine at .aidlc/, the native shell at .opencode/, the project opencode.json
// whose skills.paths + permission allowlist the status journey exercises),
// then git-initialized (opencode resolves the project root by walking to the
// worktree root).
export function setupOpencodeProject(): OpencodeProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-run-")));
  const proj = join(root, "proj");
  cpSync(OPENCODE_DIST, proj, { recursive: true });
  initializeGit(proj);
  return { proj, root };
}

/**
 * One `opencode run` turn for a line the person typed: `/aidlc ...` runs the
 * shipped command with the words after it, each word its own argument
 * (`opencode run` quotes an argument that holds a space, so a whole line would
 * arrive in quotation marks). Any other line goes to the session as it is, on
 * stdin, which `opencode run` reads as the message: on Windows the npm launcher
 * is a .cmd file, and Bun refuses an argument with a quotation mark for one.
 */
export function opencodeRunCommand(line: string, sessionId?: string): { argv: string[]; input?: string } {
  const command = /^\/aidlc(?:\s|$)/.test(line);
  const words = command ? line.replace(/^\/aidlc\s*/, "").split(/\s+/).filter(Boolean) : [];
  return {
    argv: [
      "run", ...(sessionId ? ["-s", sessionId] : []), ...(command ? ["--command", "aidlc"] : []),
      "-m", OPENCODE_MODEL, "--format", "json", ...(words.length ? ["--", ...words] : []),
    ],
    ...(command ? {} : { input: line }),
  };
}

/** The session and tool calls of one `opencode run --format json` turn, in the shape the SDK drive captures tool calls. */
export function opencodeToolResults(stdout: string): { sessionId?: string; results: CapturedToolResult[] } {
  let sessionId: string | undefined;
  const results: CapturedToolResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; sessionID?: unknown; part?: { tool?: unknown; callID?: unknown; state?: { status?: unknown; input?: Record<string, unknown>; output?: unknown; error?: unknown } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (sessionId === undefined && typeof event.sessionID === "string") sessionId = event.sessionID;
    const state = event.part?.state;
    if (event.type !== "tool_use" || !state) continue;
    results.push({
      toolName: event.part?.tool === "bash" ? "Bash" : String(event.part?.tool), input: state.input ?? {},
      toolUseId: String(event.part?.callID ?? ""), resultText: String(state.output ?? state.error ?? ""), isError: state.status === "error",
    });
  }
  return { sessionId, results };
}

/** What opencode told the person in one turn: the text parts of a `--format json` turn, or the printed reply. */
export function opencodeReplies(stdout: string, json: boolean): AgentWords[] {
  if (!json) return stdout.trim() ? [{ text: stdout.trim() }] : [];
  const replies: AgentWords[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; timestamp?: unknown; part?: { type?: unknown; text?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "text" || typeof event.part?.text !== "string" || !event.part.text.trim()) continue;
    replies.push({ ...(typeof event.timestamp === "number" ? { ts: new Date(event.timestamp).toISOString() } : {}), text: event.part.text });
  }
  return replies;
}

/** One person turn as `opencode run --format json`: a new session, or `sessionId` continued. */
export function opencodeTurn(proj: string, line: string, options: { sessionId?: string; timeoutMs?: number } = {}): ExecResult & { stdout: string } {
  const { argv, input } = opencodeRunCommand(line, options.sessionId);
  const result = spawnSync(OPENCODE_BIN, argv, {
    cwd: proj,
    encoding: "utf-8",
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
    env: { ...process.env, PWD: proj },
    timeout: remainingOperationTimeoutMs(options.timeoutMs ?? TEST_TIMEOUT_MS, { phase: "opencode turn" }),
    maxBuffer: 64 * 1024 * 1024,
  });
  keepAgentWords("opencode", opencodeReplies(result.stdout ?? "", true));
  keepLegAudit(proj);
  return {
    rc: result.status ?? -1,
    stdout: result.stdout ?? "",
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
}

// `--command aidlc` invokes the shipped .opencode/command/aidlc.md; the
// message tokens after `--` land in its $ARGUMENTS. No --auto: an unexpected
// permission ask auto-rejects and fails the asserts (the honest signal).
//
// PWD must be pinned to the project: spawnSync's `cwd` does not rewrite the
// inherited PWD env var, and opencode trusts PWD over the real cwd when
// resolving its instance directory - with the runner's checkout leaking
// through, `opencode run` dies with "Unexpected server error"
// (live-reproduced on 1.17.18).
export function runOpencode(proj: string, args: string[]): ExecResult {
  const result = spawnSync(
    OPENCODE_BIN,
    ["run", "--command", "aidlc", "-m", OPENCODE_MODEL, "--", ...args],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: remainingOperationTimeoutMs(TEST_TIMEOUT_MS, { phase: "opencode exec" }),
    },
  );
  keepAgentWords("opencode", opencodeReplies(result.stdout ?? "", false));
  keepLegAudit(proj);
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

export interface CursorProject {
  proj: string;
  root: string;
}

// A scratch install: dist/cursor copied verbatim (dotfiles included: the
// engine + native surfaces at .cursor/, AGENTS.md and the aidlc/ memory tree
// at the root), then git-initialized (Cursor resolves the workspace root by
// walking to the repo root).
export function setupCursorProject(): CursorProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-run-")));
  const proj = join(root, "proj");
  cpSync(CURSOR_DIST, proj, { recursive: true });
  initializeGit(proj);
  return { proj, root };
}

// `agent -p "<prompt>"` invokes the shipped .cursor/skills/aidlc skill with
// the flag text forwarded inline (live-verified forwarding shape). --trust
// skips the workspace-trust prompt on the scratch dir. No -f/--force: an
// unexpected permission ask auto-rejects and fails the asserts (the honest
// signal).
export function runCursor(proj: string, promptText: string): ExecResult {
  const result = spawnSync(
    CURSOR_BIN,
    [
      "-p",
      promptText,
      "--trust",
      "--model",
      CURSOR_MODEL,
      "--output-format",
      "text",
    ],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: remainingOperationTimeoutMs(TEST_TIMEOUT_MS, { phase: "Cursor exec" }),
    },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}
